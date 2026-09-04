// 日志与用户可见错误中的敏感信息统一脱敏。这里只处理展示/存储副本，
// 不改变实际请求内容，避免 API Key、Cookie 和访问令牌进入调试记录。

const HIDDEN = "[已隐藏]";

export function redactSensitiveLogText(value: string): string {
    if (!value) return value;

    return value
        // Authorization: Bearer ... 以及正文中单独出现的 Bearer token。
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, `Bearer ${HIDDEN}`)
        // OpenAI/常见平台代理 Key、Supabase personal access token。
        .replace(/\b(?:sk|rk|pk|sbp)[-_][A-Za-z0-9_-]{8,}\b/gi, HIDDEN)
        // JWT（包括 Supabase anon/service-role token）。
        .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, HIDDEN)
        // JSON、表单、Header 风格的敏感字段。保留字段名，隐藏字段值。
        .replace(/(["']?(?:api[_-]?key|authorization|cookie|credential|password|secret|access[_-]?token|refresh[_-]?token|service[_-]?role(?:[_-]?key)?|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'\s,;&}\]]{4,})/gi, `$1${HIDDEN}`)
        // URL 查询参数中的密钥/令牌。
        .replace(/([?&](?:key|api[_-]?key|access[_-]?token|refresh[_-]?token|token)=)([^&#\s]+)/gi, `$1${HIDDEN}`)
        // Cookie 请求头可能包含空格与多个键值，整段隐藏到换行/JSON 字段结束处。
        .replace(/(\bCookie\s*:\s*)([^\r\n"}]+)/gi, `$1${HIDDEN}`);
}
