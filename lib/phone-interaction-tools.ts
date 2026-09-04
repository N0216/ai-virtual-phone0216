import type { StoredCallRecord } from "./chat-db";
import type { CallHistoryRecord } from "./call-history";
import type { ChatContact, ChatMessage, ChatSession } from "./chat-storage";

export type PhoneInteractionContext = {
    sessionId?: string;
    characterId?: string;
    characterDisplayName?: string;
};

export type PhoneInteractionQuery = {
    sessionName?: string;
    characterId?: string;
    limit?: number;
    before?: string;
    query?: string;
    callId?: string;
};

export type PhoneInteractionToolResult = {
    name: "列出可查看的互动" | "查看最近聊天" | "查看通话内容";
    success: boolean;
    data?: string;
    error?: string;
};

export type PhoneInteractionReadDeps = {
    readSessions(): Promise<ChatSession[]>;
    readContacts(): Promise<ChatContact[]>;
    readMessages(sessionId: string): Promise<ChatMessage[]>;
    readStoredCalls(sessionId: string): Promise<StoredCallRecord[]>;
    readCharacterLabels(): Promise<Record<string, string>> | Record<string, string>;
    previewMessage?(message: ChatMessage): string;
    buildLegacyCallHistory(messages: ChatMessage[]): CallHistoryRecord[];
    mergeCallHistory(stored: StoredCallRecord[], legacy: CallHistoryRecord[]): CallHistoryRecord[];
    /** Phone Access Control / v7 will plug its durable lock decision into this one gate. */
    isSessionExplicitlyReadable?(session: ChatSession, characterId?: string): Promise<boolean> | boolean;
};

type ResolvedInteractionSession = {
    session: ChatSession;
    characterId?: string;
    displayName: string;
};

const MAX_LIST_LIMIT = 30;
const MAX_MESSAGE_LIMIT = 30;
const MAX_CALL_LIMIT = 20;
const MAX_TEXT_LENGTH = 2_000;
const SECRET_TEXT = /(?:bearer\s+[a-z0-9._~-]{12,}|\b(?:sk|sbp)_[a-z0-9_-]{12,}|\beyJ[a-z0-9_-]{20,}\.[a-z0-9._-]{10,})/giu;
const SECRET_FIELD_TEXT = /(["']?(?:api[_-]?key|authorization|cookie|credential|password|secret|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*["']?)([^"'\s,;&}\]]{4,})/giu;

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, Math.floor(parsed))) : fallback;
}

function safeText(value: unknown): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) return "";
    if (/^data:/iu.test(text)) return "[媒体内容已省略]";
    const redacted = text
        .replace(SECRET_TEXT, "[敏感值已隐藏]")
        .replace(SECRET_FIELD_TEXT, "$1[敏感值已隐藏]");
    return redacted.length > MAX_TEXT_LENGTH ? `${redacted.slice(0, MAX_TEXT_LENGTH)}…` : redacted;
}

/**
 * Single safe projection used by bodies, previews, search and recent summaries.
 * Retracted messages never produce a projection, so no downstream path can
 * accidentally index or cache the former body.
 */
export function projectVisibleInteractionMessage(message: ChatMessage, previewMessage?: (message: ChatMessage) => string): {
    id: string;
    speaker: "用户" | "角色";
    text: string;
    occurredAt: string;
} | null {
    if (message.isRetracted) return null;
    if (message.role !== "user" && message.role !== "assistant") return null;
    if (message.origin === "reading_discuss" || message.mediaType === "reading_discuss") return null;
    if (["tool_call", "tool_result", "tool_notice", "memory_write_request", "system_instruction"].includes(message.mediaType || "")) return null;
    const text = safeText(previewMessage?.(message) || message.content);
    if (!text) return null;
    return {
        id: message.id,
        speaker: message.role === "user" ? "用户" : "角色",
        text,
        occurredAt: message.createdAt,
    };
}

function resolveSessionIdentity(
    session: ChatSession,
    contactsById: Map<string, ChatContact>,
    contactsByCharacter: Map<string, ChatContact>,
    labels: Record<string, string>,
): ResolvedInteractionSession | null {
    if (session.isBlacklisted) return null;
    if (session.isGroup) {
        return { session, displayName: session.alias?.trim() || session.groupName?.trim() || "群聊" };
    }
    const contact = contactsById.get(session.contactId) || contactsByCharacter.get(session.contactId);
    // A removed friend leaves the old session behind. Do not expose that orphan.
    if (!contact) return null;
    const characterId = contact.characterId;
    return {
        session,
        characterId,
        displayName: session.alias?.trim() || contact.nickname?.trim() || labels[characterId] || "未命名会话",
    };
}

async function readableSessions(deps: PhoneInteractionReadDeps): Promise<ResolvedInteractionSession[]> {
    const [sessions, contacts, labels] = await Promise.all([
        deps.readSessions(), deps.readContacts(), deps.readCharacterLabels(),
    ]);
    const contactsById = new Map(contacts.map(item => [item.id, item]));
    const contactsByCharacter = new Map(contacts.map(item => [item.characterId, item]));
    const resolved = sessions
        .map(session => resolveSessionIdentity(session, contactsById, contactsByCharacter, labels))
        .filter((item): item is ResolvedInteractionSession => Boolean(item));
    if (!deps.isSessionExplicitlyReadable) return resolved;
    const decisions = await Promise.all(resolved.map(async item => (
        await deps.isSessionExplicitlyReadable!(item.session, item.characterId) ? item : null
    )));
    return decisions.filter((item): item is ResolvedInteractionSession => Boolean(item));
}

function selectSession(
    sessions: ResolvedInteractionSession[],
    query: PhoneInteractionQuery,
    context: PhoneInteractionContext,
): ResolvedInteractionSession | null {
    if (query.sessionName?.trim()) {
        const needle = query.sessionName.trim().toLocaleLowerCase();
        const matches = sessions.filter(item => item.session.id === query.sessionName
            || item.displayName.toLocaleLowerCase() === needle
            || item.displayName.toLocaleLowerCase().includes(needle));
        return matches.length === 1 ? matches[0] : null;
    }
    const characterId = query.characterId || context.characterId;
    if (characterId) {
        return sessions
            .filter(item => item.characterId === characterId || item.session.participantIds?.includes(characterId))
            .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt))[0] || null;
    }
    return context.sessionId ? sessions.find(item => item.session.id === context.sessionId) || null : null;
}

async function createDefaultDeps(): Promise<PhoneInteractionReadDeps> {
    const [contentAccessModule, callHistoryModule, chatStorageModule] = await Promise.all([
        import("./private-content-access"),
        import("./call-history"),
        import("./chat-storage"),
    ]);
    const content = await contentAccessModule.createLegacyPrivateContentAccess();
    return {
        readSessions: () => content.listSessions(),
        readContacts: () => content.listContacts(),
        readMessages: sessionId => content.listMessages(sessionId),
        readStoredCalls: sessionId => content.listCallRecords(sessionId),
        readCharacterLabels: () => content.characterLabels(),
        previewMessage: chatStorageModule.getChatMessagePreview,
        buildLegacyCallHistory: callHistoryModule.buildCallHistory,
        mergeCallHistory: callHistoryModule.mergeStoredAndLegacyCallHistory,
        isSessionExplicitlyReadable: (session, characterId) => content.canReadSession(session, characterId),
    };
}

export async function listReadablePhoneInteractions(
    query: PhoneInteractionQuery,
    _context: PhoneInteractionContext,
    suppliedDeps?: PhoneInteractionReadDeps,
): Promise<PhoneInteractionToolResult> {
    const deps = suppliedDeps || await createDefaultDeps();
    const sessions = (await readableSessions(deps))
        .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt));
    const output: Array<Record<string, unknown>> = [];
    for (const item of sessions) {
        const projected = (await deps.readMessages(item.session.id))
            .map(message => projectVisibleInteractionMessage(message, deps.previewMessage))
            .filter((message): message is NonNullable<typeof message> => Boolean(message));
        const latest = projected.at(-1);
        output.push({
            会话名称: item.displayName,
            会话类型: item.session.isGroup ? "群聊" : "单聊",
            关联角色ID: item.characterId,
            最近可见互动时间: latest?.occurredAt || null,
            最近消息摘要: latest?.text || "暂无可见消息",
        });
        if (output.length >= boundedLimit(query.limit, 10, MAX_LIST_LIMIT)) break;
    }
    return { name: "列出可查看的互动", success: true, data: JSON.stringify(output, null, 2) };
}

export async function readRecentPhoneChat(
    query: PhoneInteractionQuery,
    context: PhoneInteractionContext,
    suppliedDeps?: PhoneInteractionReadDeps,
): Promise<PhoneInteractionToolResult> {
    const deps = suppliedDeps || await createDefaultDeps();
    const resolved = selectSession(await readableSessions(deps), query, context);
    if (!resolved) return { name: "查看最近聊天", success: false, error: "找不到唯一且允许查看的目标会话" };
    const before = query.before ? new Date(query.before).getTime() : Number.POSITIVE_INFINITY;
    if (query.before && !Number.isFinite(before)) return { name: "查看最近聊天", success: false, error: "before 必须是有效时间" };
    const needle = query.query?.trim().toLocaleLowerCase() || "";
    const messages = (await deps.readMessages(resolved.session.id))
        .map(message => projectVisibleInteractionMessage(message, deps.previewMessage))
        .filter((message): message is NonNullable<typeof message> => Boolean(message))
        .filter(message => new Date(message.occurredAt).getTime() < before)
        .filter(message => !needle || message.text.toLocaleLowerCase().includes(needle))
        .slice(-boundedLimit(query.limit, 10, MAX_MESSAGE_LIMIT));
    return {
        name: "查看最近聊天",
        success: true,
        data: JSON.stringify({ 会话名称: resolved.displayName, 消息: messages }, null, 2),
    };
}

function sanitizeCallRecord(record: CallHistoryRecord) {
    return {
        通话ID: record.id,
        类型: record.type === "voice" ? "语音" : "视频",
        发起方: record.initiatorRole === "user" ? "用户" : "角色",
        开始时间: record.startedAt,
        结束时间: record.endedAt,
        时长: record.duration,
        状态: record.state,
        转录: record.transcript.map(entry => ({
            speaker: entry.role === "user" ? "用户" : "角色",
            content: safeText(entry.content),
            occurredAt: entry.createdAt,
            ...(entry.senderName ? { senderName: safeText(entry.senderName) } : {}),
        })).filter(entry => entry.content),
    };
}

export async function readPhoneCallHistory(
    query: PhoneInteractionQuery,
    context: PhoneInteractionContext,
    suppliedDeps?: PhoneInteractionReadDeps,
): Promise<PhoneInteractionToolResult> {
    const deps = suppliedDeps || await createDefaultDeps();
    const resolved = selectSession(await readableSessions(deps), query, context);
    if (!resolved) return { name: "查看通话内容", success: false, error: "找不到唯一且允许查看的目标会话" };
    const [stored, messages] = await Promise.all([
        deps.readStoredCalls(resolved.session.id), deps.readMessages(resolved.session.id),
    ]);
    const safeLegacyMessages = messages.filter(message => !message.isRetracted);
    const legacy = deps.buildLegacyCallHistory(safeLegacyMessages);
    let records = deps.mergeCallHistory(stored, legacy);
    if (query.callId) records = records.filter(record => record.id === query.callId);
    else records = records.slice(0, boundedLimit(query.limit, 5, MAX_CALL_LIMIT));
    if (query.callId && records.length === 0) return { name: "查看通话内容", success: false, error: "没有找到这次通话" };
    return {
        name: "查看通话内容",
        success: true,
        data: JSON.stringify({ 会话名称: resolved.displayName, 通话记录: records.map(sanitizeCallRecord) }, null, 2),
    };
}
