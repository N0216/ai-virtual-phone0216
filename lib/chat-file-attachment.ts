import JSZip from "jszip";

export const MAX_CHAT_FILE_BYTES = 20 * 1024 * 1024;
// Keep attachments useful without silently feeding an enormous document into
// every following model request (which would quickly burn API context/tokens).
export const MAX_CHAT_FILE_TEXT_CHARS = 30_000;

export type PreparedChatFile = {
    fileType: "audio" | "image" | "video" | "file";
    content: string;
    readable: boolean;
    truncated: boolean;
};

const TEXT_EXTENSIONS = new Set([
    "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "xml", "html", "htm",
    "css", "scss", "less", "js", "jsx", "ts", "tsx", "py", "java", "c", "cc", "cpp",
    "h", "hpp", "go", "rs", "php", "rb", "swift", "kt", "kts", "sql", "yaml", "yml",
    "toml", "ini", "conf", "log", "sh", "ps1", "bat", "cmd", "vue", "svelte",
]);

function extensionOf(name: string): string {
    return name.toLowerCase().split(".").pop() || "";
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function xmlToText(xml: string): string {
    return decodeXmlEntities(xml
        .replace(/<w:tab\s*\/?\s*>/gi, "\t")
        .replace(/<w:br\s*\/?\s*>/gi, "\n")
        .replace(/<\/(?:w:p|a:p)>/gi, "\n")
        .replace(/<\/(?:w:tr|row)>/gi, "\n")
        .replace(/<\/(?:w:tc|c)>/gi, "\t")
        .replace(/<[^>]+>/g, ""))
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function naturalPathSort(a: string, b: string): number {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function extractOfficeText(file: File, extension: string): Promise<string> {
    const zip = await JSZip.loadAsync(await file.arrayBuffer());
    let paths: string[] = [];
    if (extension === "docx") {
        paths = ["word/document.xml"];
    } else if (extension === "pptx") {
        paths = Object.keys(zip.files).filter(path => /^ppt\/slides\/slide\d+\.xml$/i.test(path)).sort(naturalPathSort);
    } else if (extension === "xlsx") {
        paths = [
            ...Object.keys(zip.files).filter(path => path === "xl/sharedStrings.xml"),
            ...Object.keys(zip.files).filter(path => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path)).sort(naturalPathSort),
        ];
    }
    const sections: string[] = [];
    for (const path of paths) {
        const entry = zip.file(path);
        if (!entry) continue;
        const text = xmlToText(await entry.async("string"));
        if (text) sections.push(text);
    }
    return sections.join("\n\n");
}

function limitText(text: string): { text: string; truncated: boolean } {
    if (text.length <= MAX_CHAT_FILE_TEXT_CHARS) return { text, truncated: false };
    return {
        text: `${text.slice(0, MAX_CHAT_FILE_TEXT_CHARS)}\n\n[文件正文过长，已只传入前 ${MAX_CHAT_FILE_TEXT_CHARS.toLocaleString()} 个字符]`,
        truncated: true,
    };
}

export async function prepareChatFile(file: File): Promise<PreparedChatFile> {
    const mime = file.type || "application/octet-stream";
    const extension = extensionOf(file.name);
    const metadata = `文件名：${file.name}\n文件类型：${mime}\n文件大小：${file.size} 字节`;

    if (mime.startsWith("image/")) {
        return { fileType: "image", content: `[用户发送了图片文件]\n${metadata}`, readable: true, truncated: false };
    }
    if (mime.startsWith("audio/")) {
        return { fileType: "audio", content: `[用户发送了音频文件]\n${metadata}\n当前仅附带文件本身，未自动生成语音转文字。`, readable: false, truncated: false };
    }
    if (mime.startsWith("video/")) {
        return { fileType: "video", content: `[用户发送了视频文件]\n${metadata}\n当前仅附带文件本身，未自动提取画面或语音。`, readable: false, truncated: false };
    }

    try {
        let extracted = "";
        if (mime.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) {
            extracted = await file.text();
        } else if (["docx", "pptx", "xlsx"].includes(extension)) {
            extracted = await extractOfficeText(file, extension);
        } else if (extension === "pdf" || mime === "application/pdf") {
            const { parsePdfPageRange } = await import("./reading-parser");
            const parsed = await parsePdfPageRange(file, { startPage: 1, endPage: 50, fileName: file.name });
            extracted = parsed.chunks
                .map(chunk => `${chunk.title}\n${chunk.paragraphs.join("\n")}`)
                .join("\n\n");
            if (parsed.totalPages > 50) extracted += `\n\n[PDF 共 ${parsed.totalPages} 页，本次只读取前 50 页]`;
        } else if (extension === "epub" || mime === "application/epub+zip") {
            const { parseEpubFile } = await import("./reading-parser");
            const parsed = await parseEpubFile(await file.arrayBuffer(), file.name);
            extracted = parsed.chapters
                .map(chapter => `${chapter.title}\n${chapter.paragraphs.join("\n")}`)
                .join("\n\n");
        }
        if (extracted.trim()) {
            const limited = limitText(extracted.trim());
            return {
                fileType: "file",
                content: `[用户发送了可读取文件]\n${metadata}\n\n文件正文：\n${limited.text}`,
                readable: true,
                truncated: limited.truncated,
            };
        }
    } catch { /* keep the attachment and report that its body was not extracted */ }

    return {
        fileType: "file",
        content: `[用户发送了文件]\n${metadata}\n文件已附加，但当前版本未能提取该格式的正文；不要编造文件内容。`,
        readable: false,
        truncated: false,
    };
}
