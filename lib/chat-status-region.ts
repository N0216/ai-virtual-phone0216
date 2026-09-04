// lib/chat-status-region.ts
// 自定义状态栏（状态区）：会话级配置 + 默认预设宏解析。
//
// 机制：默认预设的「内心想法」章节改为宏 {{statusRegionSection}}（主动消息示例行
// 对应 {{statusRegionExampleLine}}），按本模块的会话配置解析：
//   native（默认）→ 原章节文本，字节级等于历史版本，所有存量用户无感；
//   off           → 空，整节从提示词消失，AI 自然不再输出 [内心]；
//   custom        → 「## 状态栏」+ 契约整段正文（契约自带【逻辑】【格式】与包裹要求）。
// 只有包含宏的预设（默认预设天生包含；社区预设作者可自愿声明）支持自定义——
// 不含宏的预设完全不受本机制影响，聊天信息页的入口会置灰。
//
// 渲染侧配套：custom 模式下生成的消息盖 statusRegionMode 戳，折叠区不再画
// 便利贴容器，改由用户的渲染代码（沙盒 iframe，AI 壳内原文经 window.STATUS_RAW
// 与 {{RAW}} 注入）接管。原生时期的消息永远按原生渲染，切换可逆。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type StatusRegionMode = "native" | "off" | "custom";

/** 解析变体：单聊与群聊的 native 原文不同，自定义挡群聊还要补"每人各出一份"的规则 */
export type StatusRegionVariant = "single" | "group";

export type StatusRegionConfig = {
    mode: StatusRegionMode;
    /** 独立于状态栏外观：开启后每次正式回复都必须输出一次内心独白。旧配置缺省为开启。 */
    innerMonologueEnabled?: boolean;
    /** 输出契约：告诉 AI [状态栏] 壳内输出什么（custom 模式生效） */
    contract: string;
    /** 输出渲染：完整 HTML（可含 JS），沙盒 iframe 执行，接管折叠区绘制 */
    renderHtml: string;
    /** 预览用示例数据（[状态栏] 壳内原文的样例）。只用于编辑弹窗里的实时预览，
     *  不参与提示词，也不影响渲染。小卷写入契约时一并给出，否则预览会拿默认样例
     *  去套新契约的字段，显示成空白或错乱。缺省为空表示用内置样例。 */
    previewRaw?: string;
};

const STORAGE_KEY = "ai_phone_chat_status_region_v1";

/** 配置被外部改写（小卷工具）后广播，已打开的聊天信息页据此刷新，
 *  否则面板的状态只在挂载时初始化一次，会停在旧值——写了但前台看不见。 */
export const STATUS_REGION_UPDATED_EVENT = "chat-status-region-updated";
registerKvMigration(STORAGE_KEY);

/** 状态栏方案库在 css-scheme-storage 里的 target 键（负载=契约+渲染+示例数据 JSON） */
export const STATUS_REGION_SCHEME_TARGET = "chat_status_region";

export const STATUS_REGION_SECTION_MACRO = "{{statusRegionSection}}";
export const STATUS_REGION_EXAMPLE_MACRO = "{{statusRegionExampleLine}}";
export const STATUS_REGION_COMPOSITION_MACRO = "{{statusRegionComposition}}";
export const STATUS_REGION_FULL_EXAMPLE_MACRO = "{{statusRegionFullExample}}";

/** 原「## 状态数值」+「## 内心想法」章节原文——native 挡解析值，必须与历史版本逐字一致。
 *  状态数值也归入状态区：关闭原生后 [好感度:X] 等标签一并从提示词移除（好感度等会话状态随之停更）。 */
export const NATIVE_STATUS_REGION_SECTION = [
    "## 状态数值",
    "【逻辑】基于当前状态 {{state}}，根据本轮对话的情绪起伏进行实时增减（范围 0-100）。",
    "【格式】[好感度:X][占有欲:X][焦虑值:X]",
    "【示例】[好感度:85][占有欲:60][焦虑值:45]",
    "",
    "## 内心想法",
    "【逻辑】反映角色在回复前的真实心理活动、潜台词或情绪波动。",
    "【格式】[内心]在此处填写内心的潜台词[/内心]",
].join("\n");

/** 群聊「### 状态值与内心」章节原文——群聊 native 挡的解析值，必须与历史版本逐字一致。
 *  与单聊那份不同：群聊要求每个发言角色在自己的 [角色名]: 块内各输出一份，且互不混用。 */
export const NATIVE_STATUS_REGION_SECTION_GROUP = [
    "### 状态值与内心",
    "【格式】",
    "每个本轮发言角色都必须先输出自己的状态值和内心想法，且必须放在该角色的同一个 [角色名]: 块内。",
    "同一个角色块只写一次 [角色名]: 前缀；不要把状态值/内心单独拆成一个角色块，也不要在正文前重复 [角色名]:。",
    "[角色名]: [好感度:X][占有欲:X][焦虑值:X]",
    "[内心]该角色此刻没有说出口的真实想法[/内心]",
    "消息正文",
    "【规则】",
    "- 状态值继承该角色 <member> 内的 current_state，并根据本轮群聊互动更新。",
    "- 不同角色的状态值互不混用；谁发言，就只输出谁自己的状态值和内心。",
    "- 不发言的角色不要输出状态值或内心。",
    "- 同一个角色在同一轮里只需要输出一次状态值和一次内心，后续多条消息用空行拆分即可。",
].join("\n");

/** 主动消息类条目里的静默输出格式原文（静默行+状态值行+内心行整块归宏） */
export const NATIVE_STATUS_REGION_EXAMPLE_LINE = [
    "如果决定静默，按照以下格式输出：",
    "[好感度:X][占有欲:X][焦虑值:X]",
    "[内心]你的所有内心想法写在这里。[/内心]",
].join("\n");

/** 文字聊天模式开头的【输出构成】行原文 */
export const NATIVE_STATUS_REGION_COMPOSITION =
    "【输出构成】输出格式由四个部分组成：状态数值、内心想法、聊天消息、富媒体动作（可选）。";

/** 「## 完整示例」里的状态值+内心两行原文 */
export const NATIVE_STATUS_REGION_FULL_EXAMPLE = [
    "[好感度:72][占有欲:25][焦虑值:15]",
    "[内心]等了{{user}}一整晚，回复这么冷淡，心里有点堵得慌。[/内心]",
].join("\n");

export const DEFAULT_STATUS_REGION_CONFIG: StatusRegionConfig = {
    mode: "native",
    innerMonologueEnabled: true,
    contract: "",
    renderHtml: "",
    previewRaw: "",
};

function loadAll(): Record<string, StatusRegionConfig> {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(kvGet(STORAGE_KEY) || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, StatusRegionConfig>
            : {};
    } catch {
        return {};
    }
}

export function getStatusRegionConfig(sessionId: string): StatusRegionConfig {
    const raw = loadAll()[sessionId];
    if (!raw || typeof raw !== "object") return { ...DEFAULT_STATUS_REGION_CONFIG };
    const mode = raw.mode === "off" || raw.mode === "custom" ? raw.mode : "native";
    return {
        mode,
        innerMonologueEnabled: raw.innerMonologueEnabled !== false,
        contract: typeof raw.contract === "string" ? raw.contract : "",
        renderHtml: typeof raw.renderHtml === "string" ? raw.renderHtml : "",
        previewRaw: typeof raw.previewRaw === "string" ? raw.previewRaw : "",
    };
}

export function saveStatusRegionConfig(sessionId: string, config: StatusRegionConfig): void {
    if (typeof window === "undefined") return;
    const all = loadAll();
    if (
        config.mode === "native"
        && config.innerMonologueEnabled !== false
        && !config.contract.trim()
        && !config.renderHtml.trim()
    ) {
        delete all[sessionId];
    } else {
        all[sessionId] = config;
    }
    kvSet(STORAGE_KEY, JSON.stringify(all));
}

/** custom 是否真正生效（契约与渲染都要有内容，缺一回退 native 行为） */
export function isCustomStatusRegionActive(config: StatusRegionConfig): boolean {
    return config.mode === "custom" && !!config.contract.trim() && !!config.renderHtml.trim();
}

/** {{statusRegionSection}} 的解析值。
 *  variant=group 时用群聊那份 native 原文；custom 挡额外补一条"每个发言角色各出一份"的群规则，
 *  否则模型会只在整轮输出里给一个状态栏。 */
export function resolveStatusRegionSection(
    config: StatusRegionConfig,
    variant: StatusRegionVariant = "single",
): string {
    const monologueEnabled = config.innerMonologueEnabled !== false;
    const mandatoryInner = [
        "## 内心想法（强制）",
        "【规则】只要本轮输出正式回复，就必须且只能输出一次 [内心]...[/内心]，不可省略、不可留空；短回复、主动消息、自动醒来与重试回复同样适用。",
        "【格式】[内心]角色此刻没有说出口的真实心理活动、潜台词或情绪波动[/内心]",
    ].join("\n");
    if (config.mode === "off") return monologueEnabled ? mandatoryInner : "";
    if (isCustomStatusRegionActive(config)) {
        // 契约即「## 状态栏」章节的整个正文（含【逻辑】【格式】与 [状态栏] 包裹要求），不再套固定信封
        const body = "## 状态栏\n" + config.contract.trim()
            + (monologueEnabled ? `\n\n${mandatoryInner}` : "\n\n【内心独白】已关闭，不要输出 [内心] 标签。");
        if (variant !== "group") return body;
        return [
            body,
            "",
            "【群聊补充】每个本轮发言的角色都要在自己的 [角色名]: 块内、正文之前，按上面的契约各输出一份",
            "[状态栏]...[/状态栏]；不同角色的数据互不混用，不发言的角色不输出。",
            "下方若有【完整示例】，其中每个角色的 [好感度:X][占有欲:X][焦虑值:X] 与 [内心]...[/内心] 两行",
            "一律以本契约的 [状态栏]...[/状态栏] 取代。",
        ].join("\n");
    }
    if (monologueEnabled) {
        return variant === "group"
            ? NATIVE_STATUS_REGION_SECTION_GROUP + "\n- 每个正式发言角色都必须输出一次且仅一次非空 [内心]...[/内心]。"
            : NATIVE_STATUS_REGION_SECTION + "\n【强制】每次正式回复必须且只能输出一次非空 [内心]...[/内心]，不可省略。";
    }
    if (variant === "group") {
        return NATIVE_STATUS_REGION_SECTION_GROUP
            .replace("### 状态值与内心", "### 状态值")
            .replace(/与内心想法/g, "")
            .replace(/\n\[内心\][^\n]+\[\/内心\]/g, "")
            .replace(/\n- [^\n]*内心[^\n]*/g, "")
            + "\n- 内心独白已关闭，不要输出 [内心] 标签。";
    }
    return NATIVE_STATUS_REGION_SECTION.split("\n\n## 内心想法")[0]
        + "\n\n【内心独白】已关闭，不要输出 [内心] 标签。";
}

/** {{statusRegionExampleLine}} 的解析值（主动消息类条目的静默输出格式块） */
export function resolveStatusRegionExampleLine(config: StatusRegionConfig): string {
    const monologueEnabled = config.innerMonologueEnabled !== false;
    if (config.mode === "off") return monologueEnabled
        ? "如果决定静默，不输出任何内容；如果输出正式消息，必须同时输出一次非空 [内心]...[/内心]。"
        : "如果决定静默，不输出任何内容。";
    if (isCustomStatusRegionActive(config)) {
        return "如果决定静默，按照以下格式输出：\n[状态栏]（按状态栏契约输出）[/状态栏]"
            + (monologueEnabled ? "\n[内心]本次真实心理活动[/内心]" : "");
    }
    return monologueEnabled
        ? NATIVE_STATUS_REGION_EXAMPLE_LINE
        : [
            "如果决定静默，按照以下格式输出：",
            "[好感度:X][占有欲:X][焦虑值:X]",
            "不要输出 [内心] 标签。",
        ].join("\n");
}

/** {{statusRegionComposition}} 的解析值（文字聊天模式的【输出构成】行） */
export function resolveStatusRegionComposition(config: StatusRegionConfig): string {
    const monologueEnabled = config.innerMonologueEnabled !== false;
    if (config.mode === "off") return monologueEnabled
        ? "【输出构成】输出格式由三个部分组成：内心想法（强制）、聊天消息、富媒体动作（可选）。"
        : "【输出构成】输出格式由两个部分组成：聊天消息、富媒体动作（可选）。";
    if (isCustomStatusRegionActive(config)) {
        return monologueEnabled
            ? "【输出构成】输出格式由四个部分组成：状态栏、内心想法（强制）、聊天消息、富媒体动作（可选）。"
            : "【输出构成】输出格式由三个部分组成：状态栏、聊天消息、富媒体动作（可选）。";
    }
    return monologueEnabled
        ? NATIVE_STATUS_REGION_COMPOSITION
        : "【输出构成】输出格式由三个部分组成：状态数值、聊天消息、富媒体动作（可选）；不要输出 [内心] 标签。";
}

/** {{statusRegionFullExample}} 的解析值（「## 完整示例」里的状态值+内心行） */
export function resolveStatusRegionFullExample(config: StatusRegionConfig): string {
    const monologueEnabled = config.innerMonologueEnabled !== false;
    if (config.mode === "off") return monologueEnabled ? "[内心]本次回复前真实但没有说出口的想法。[/内心]" : "";
    if (isCustomStatusRegionActive(config)) return "[状态栏]（按状态栏契约输出）[/状态栏]"
        + (monologueEnabled ? "\n[内心]本次回复前真实但没有说出口的想法。[/内心]" : "");
    return monologueEnabled
        ? NATIVE_STATUS_REGION_FULL_EXAMPLE
        : "[好感度:72][占有欲:25][焦虑值:15]";
}

/** 预设是否声明了状态区宏（聊天信息页自定义入口的可用性判定） */
export function presetSupportsStatusRegion(presetPromptTexts: string[]): boolean {
    return presetPromptTexts.some(text => text.includes(STATUS_REGION_SECTION_MACRO));
}
