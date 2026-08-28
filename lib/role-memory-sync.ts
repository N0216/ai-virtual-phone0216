import { loadCharacters } from "./character-storage";
import {
  CHAT_MESSAGE_PUSHED_EVENT,
  CHAT_MESSAGES_DELETED_EVENT,
  CHAT_RESPONSE_BATCH_REPLACED_EVENT,
  getChatMessagePreview,
  isChatStorageHydrated,
  loadChatContacts,
  loadChatMessages,
  loadChatSessions,
  type ChatMessage,
  type ChatSession,
} from "./chat-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { getAllCharacterIdsWithMemories, loadMemoryEntries } from "./memory-storage";
import {
  isPersonalPushCloudActive,
  loadPersonalPushCloudState,
  personalPushFetch,
  PERSONAL_PUSH_SCHEMA_VERSION,
} from "./personal-push-cloud";

const SYNC_STATE_KEY = "role_memory_sync_state_v1";
const CONTEXT_CACHE_KEY = "role_memory_context_cache_v1";
const SYNC_INTERVAL_MS = 2 * 60_000;
const RECENT_BATCH_SIZE = 100;
const BACKFILL_BATCH_SIZE = 80;

registerKvMigration(SYNC_STATE_KEY);
registerKvMigration(CONTEXT_CACHE_KEY);

type PendingDelete = { roleId: string; messageId: string };
type SyncState = {
  backfilledBySession: Record<string, number>;
  pendingDeletes: PendingDelete[];
  syncedMessageVersions: Record<string, string>;
  syncedMemoryVersionsByRole: Record<string, Record<string, string>>;
  lastSyncedAt?: string;
};

export type RoleCloudContext = {
  fetchedAt: string;
  handoff: null | {
    summary?: string;
    recent_context?: unknown[];
    important_facts?: unknown[];
    open_topics?: unknown[];
    last_chat_at?: string;
    created_at?: string;
  };
  memories: Array<{
    id?: string;
    content?: string;
    importance?: number;
    source?: string;
    updated_at?: string;
  }>;
  officialMessages?: Array<{
    speaker?: string;
    content?: string;
    message_at?: string;
  }>;
};

type ContextCache = Record<string, RoleCloudContext>;

function loadSyncState(): SyncState {
  try {
    const parsed = JSON.parse(kvGet(SYNC_STATE_KEY) || "{}") as Partial<SyncState> & {
      syncedMemoryIdsByRole?: Record<string, string[]>;
    };
    const migratedMemoryVersions: Record<string, Record<string, string>> = {};
    if (parsed.syncedMemoryVersionsByRole && typeof parsed.syncedMemoryVersionsByRole === "object") {
      Object.assign(migratedMemoryVersions, parsed.syncedMemoryVersionsByRole);
    } else if (parsed.syncedMemoryIdsByRole && typeof parsed.syncedMemoryIdsByRole === "object") {
      for (const [roleId, ids] of Object.entries(parsed.syncedMemoryIdsByRole)) {
        migratedMemoryVersions[roleId] = Object.fromEntries((Array.isArray(ids) ? ids : []).map(id => [id, ""]));
      }
    }
    return {
      backfilledBySession: parsed.backfilledBySession && typeof parsed.backfilledBySession === "object"
        ? parsed.backfilledBySession : {},
      pendingDeletes: Array.isArray(parsed.pendingDeletes) ? parsed.pendingDeletes.slice(-500) : [],
      syncedMessageVersions: parsed.syncedMessageVersions && typeof parsed.syncedMessageVersions === "object"
        ? parsed.syncedMessageVersions : {},
      syncedMemoryVersionsByRole: migratedMemoryVersions,
      lastSyncedAt: typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : undefined,
    };
  } catch {
    return {
      backfilledBySession: {},
      pendingDeletes: [],
      syncedMessageVersions: {},
      syncedMemoryVersionsByRole: {},
    };
  }
}

function saveSyncState(state: SyncState): void {
  kvSet(SYNC_STATE_KEY, JSON.stringify(state));
}

function loadContextCache(): ContextCache {
  try {
    const parsed = JSON.parse(kvGet(CONTEXT_CACHE_KEY) || "{}") as ContextCache;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function personalRoleSyncReady(): boolean {
  const state = loadPersonalPushCloudState();
  return Boolean(
    isPersonalPushCloudActive()
    && state?.healthStatus === "ready"
    && state.schemaVersion >= PERSONAL_PUSH_SCHEMA_VERSION,
  );
}

function roleForSession(session: ChatSession): { roleId: string; roleName: string } | null {
  if (session.isGroup) {
    return { roleId: `group:${session.id}`, roleName: session.alias?.trim() || session.groupName?.trim() || "群聊" };
  }
  const contact = loadChatContacts().find(item => item.id === session.contactId);
  if (!contact?.characterId) return null;
  const character = loadCharacters().find(item => item.id === contact.characterId);
  return {
    roleId: contact.characterId,
    roleName: session.alias?.trim() || contact.nickname?.trim() || character?.name?.trim() || contact.characterId,
  };
}

function redactLikelyCredential(value: string): string {
  return value
    .replace(/\bsbp_[A-Za-z0-9_-]{20,}\b/g, "[已隐藏 Supabase 令牌]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[已隐藏 API 密钥]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[已隐藏访问令牌]");
}

function syncableMessage(message: ChatMessage): boolean {
  if (!message.sessionId || !["user", "assistant", "system"].includes(message.role)) return false;
  if (message.role === "system" && (message.mediaType === "system_instruction" || message.mediaType === "tool_notice")) return false;
  if (message.mediaType === "tool_call" || message.mediaType === "tool_result") return false;
  return true;
}

function serializeMessage(message: ChatMessage, session: ChatSession, role: { roleId: string; roleName: string }) {
  const content = redactLikelyCredential(message.content?.trim() || getChatMessagePreview(message) || "[非文字消息]");
  return {
    roleId: role.roleId,
    roleName: role.roleName,
    sessionId: session.id,
    messageId: message.id,
    speaker: message.role,
    content,
    messageOrder: message.order,
    messageAt: message.createdAt,
    metadata: {
      ...(message.mediaType ? { mediaType: message.mediaType } : {}),
      ...(message.isRetracted ? { retracted: true } : {}),
      ...(message.origin ? { origin: message.origin } : {}),
    },
  };
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function messageVersion(message: ChatMessage): string {
  return stableHash(JSON.stringify({
    content: message.content || "",
    createdAt: message.createdAt,
    mediaType: message.mediaType || "",
    order: message.order,
    origin: message.origin || "",
    retracted: Boolean(message.isRetracted),
    role: message.role,
  }));
}

function memoryVersion(entry: Awaited<ReturnType<typeof loadMemoryEntries>>[number]): string {
  return stableHash(JSON.stringify({
    content: entry.content,
    importance: entry.importance,
    type: entry.type,
    updatedAt: entry.updatedAt,
  }));
}

async function sendBatch(upserts: unknown[], deletes: PendingDelete[]): Promise<boolean> {
  if (upserts.length === 0 && deletes.length === 0) return true;
  const response = await personalPushFetch("role-messages-sync", {
    method: "POST",
    body: JSON.stringify({ upserts, deletes }),
  }).catch(() => null);
  if (!response?.ok) return false;
  const data = await response.json().catch(() => null) as { ok?: boolean } | null;
  return data?.ok === true;
}

async function pullRoleContext(roleId: string, cache: ContextCache): Promise<void> {
  const response = await personalPushFetch("role-context", { method: "GET" }, { roleId }).catch(() => null);
  if (!response?.ok) return;
  const data = await response.json().catch(() => null) as {
    ok?: boolean;
    handoff?: RoleCloudContext["handoff"];
    memories?: RoleCloudContext["memories"];
    officialMessages?: RoleCloudContext["officialMessages"];
  } | null;
  if (!data?.ok) return;
  cache[roleId] = {
    fetchedAt: new Date().toISOString(),
    handoff: data.handoff || null,
    memories: Array.isArray(data.memories) ? data.memories : [],
    officialMessages: Array.isArray(data.officialMessages) ? data.officialMessages : [],
  };
}

async function syncLocalMemories(roleId: string, roleName: string, state: SyncState): Promise<void> {
  const entries = await loadMemoryEntries(roleId);
  const previousVersions = state.syncedMemoryVersionsByRole[roleId] || {};
  const currentVersions = Object.fromEntries(entries.map(entry => [entry.id, memoryVersion(entry)]));
  const changedEntries = entries.filter(entry => previousVersions[entry.id] !== currentVersions[entry.id]);
  const activeSet = new Set(entries.map(entry => entry.id));
  const deletedIds = Object.keys(previousVersions).filter(id => !activeSet.has(id));
  if (changedEntries.length === 0 && deletedIds.length === 0) return;

  const entryChunks = Array.from({ length: Math.ceil(changedEntries.length / 50) }, (_, index) => (
    changedEntries.slice(index * 50, (index + 1) * 50)
  ));
  if (entryChunks.length === 0) entryChunks.push([]);
  const deleteChunks = Array.from({ length: Math.ceil(deletedIds.length / 200) }, (_, index) => (
    deletedIds.slice(index * 200, (index + 1) * 200)
  ));
  if (deleteChunks.length === 0) deleteChunks.push([]);
  const calls = Math.max(entryChunks.length, deleteChunks.length);
  for (let index = 0; index < calls; index += 1) {
    const entryChunk = entryChunks[index] || [];
    const response = await personalPushFetch("role-local-memories-sync", {
      method: "POST",
      body: JSON.stringify({
        roleId,
        roleName,
        entries: entryChunk.map(entry => ({
        id: entry.id,
        content: entry.content,
        importance: Math.max(1, Math.min(5, Math.round((entry.importance || 0.6) * 5))),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        metadata: { localType: entry.type, sourceApp: entry.sourceApp },
        })),
        deletedIds: deleteChunks[index] || [],
      }),
    }).catch(() => null);
    if (!response?.ok) return;
    const data = await response.json().catch(() => null) as { ok?: boolean } | null;
    if (!data?.ok) return;
  }
  state.syncedMemoryVersionsByRole[roleId] = currentVersions;
}

let running = false;

export async function syncRoleMemoryNow(): Promise<void> {
  if (running || !isChatStorageHydrated() || !personalRoleSyncReady()) return;
  running = true;
  try {
    const state = loadSyncState();
    const sessions = loadChatSessions();
    const roles = new Set<string>();
    for (const session of sessions) {
      const role = roleForSession(session);
      if (!role) continue;
      roles.add(role.roleId);
      const messages = loadChatMessages(session.id).filter(syncableMessage);
      if (messages.length === 0) continue;
      const recent = messages.slice(-RECENT_BATCH_SIZE);
      const alreadyBackfilled = Math.max(0, state.backfilledBySession[session.id] || 0);
      const olderEnd = Math.max(0, messages.length - RECENT_BATCH_SIZE - alreadyBackfilled);
      const olderStart = Math.max(0, olderEnd - BACKFILL_BATCH_SIZE);
      const older = messages.slice(olderStart, olderEnd);
      const unique = new Map([...older, ...recent].map(message => [message.id, message]));
      const changed = [...unique.values()].map(message => ({
        key: `${session.id}:${message.id}`,
        message,
        version: messageVersion(message),
      })).filter(item => state.syncedMessageVersions[item.key] !== item.version);
      let uploaded = true;
      for (let index = 0; index < changed.length; index += 100) {
        const chunk = changed.slice(index, index + 100);
        if (!await sendBatch(chunk.map(item => serializeMessage(item.message, session, role)), [])) {
          uploaded = false;
          break;
        }
        for (const item of chunk) state.syncedMessageVersions[item.key] = item.version;
      }
      if (uploaded) {
        state.backfilledBySession[session.id] = alreadyBackfilled + older.length;
      }
    }

    if (state.pendingDeletes.length > 0 && await sendBatch([], state.pendingDeletes.slice(0, 240))) {
      state.pendingDeletes = state.pendingDeletes.slice(240);
    }

    const memoryRoleIds = await getAllCharacterIdsWithMemories();
    for (const roleId of memoryRoleIds) roles.add(roleId);
    for (const roleId of Object.keys(state.syncedMemoryVersionsByRole)) roles.add(roleId);
    const characters = loadCharacters();
    for (const roleId of roles) {
      const roleName = characters.find(character => character.id === roleId)?.name || roleId;
      await syncLocalMemories(roleId, roleName, state);
    }
    state.lastSyncedAt = new Date().toISOString();
    saveSyncState(state);

    const cache = loadContextCache();
    for (const roleId of roles) await pullRoleContext(roleId, cache);
    kvSet(CONTEXT_CACHE_KEY, JSON.stringify(cache));
  } finally {
    running = false;
  }
}

export function queueRoleMemoryDeletes(messages: ChatMessage[]): void {
  const sessions = loadChatSessions();
  const state = loadSyncState();
  for (const message of messages) {
    const session = sessions.find(item => item.id === message.sessionId);
    const role = session ? roleForSession(session) : null;
    if (!role) continue;
    state.pendingDeletes.push({ roleId: role.roleId, messageId: message.id });
  }
  state.pendingDeletes = [...new Map(state.pendingDeletes.map(item => [`${item.roleId}:${item.messageId}`, item])).values()].slice(-500);
  saveSyncState(state);
}

export function formatRoleCloudContextForPrompt(roleId: string): string {
  if (typeof window === "undefined" || !roleId) return "";
  const context = loadContextCache()[roleId];
  if (!context) return "";
  const lines: string[] = [];
  if (context.handoff?.summary) {
    lines.push("### 跨软件最近交接", context.handoff.summary.trim());
    if (Array.isArray(context.handoff.recent_context) && context.handoff.recent_context.length > 0) {
      const recent = context.handoff.recent_context.slice(-30).map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const speaker = String(record.role || record.speaker || "消息");
          const content = String(record.content || record.text || "");
          return content ? `${speaker}：${content}` : "";
        }
        return "";
      }).filter(Boolean);
      if (recent.length > 0) lines.push("最近上下文：", ...recent);
    }
    if (Array.isArray(context.handoff.important_facts) && context.handoff.important_facts.length > 0) {
      lines.push(`本次重要事项：${context.handoff.important_facts.map(String).join("；")}`);
    }
    if (Array.isArray(context.handoff.open_topics) && context.handoff.open_topics.length > 0) {
      lines.push(`未完话题：${context.handoff.open_topics.map(String).join("；")}`);
    }
  }
  const officialMessages = (context.officialMessages || [])
    .filter(item => typeof item.content === "string" && item.content.trim())
    .slice(-16)
    .map(item => `${item.speaker === "user" ? "用户" : item.speaker === "assistant" ? "角色" : "系统"}：${item.content!.trim()}`);
  if (officialMessages.length > 0) lines.push("### 官 G 最近聊天", ...officialMessages);
  const memories = context.memories
    .filter(item => item.source !== "phone")
    .filter(item => typeof item.content === "string" && item.content.trim())
    .slice(0, 16)
    .map(item => `- ${item.content!.trim()}`);
  if (memories.length > 0) lines.push("### 官 G 与小手机共享记忆", ...memories);
  // 交接信息会进入主聊天模型上下文；限制体积，避免每轮重复消耗大量主模型 Token。
  return lines.join("\n").slice(0, 12_000);
}

export function installRoleMemorySyncListeners(onSchedule: () => void): () => void {
  const pushed = () => onSchedule();
  const replaced = () => onSchedule();
  const deleted = (event: Event) => {
    const messages = (event as CustomEvent<{ messages?: ChatMessage[] }>).detail?.messages;
    if (Array.isArray(messages)) queueRoleMemoryDeletes(messages);
    onSchedule();
  };
  window.addEventListener(CHAT_MESSAGE_PUSHED_EVENT, pushed);
  window.addEventListener(CHAT_RESPONSE_BATCH_REPLACED_EVENT, replaced);
  window.addEventListener(CHAT_MESSAGES_DELETED_EVENT, deleted);
  return () => {
    window.removeEventListener(CHAT_MESSAGE_PUSHED_EVENT, pushed);
    window.removeEventListener(CHAT_RESPONSE_BATCH_REPLACED_EVENT, replaced);
    window.removeEventListener(CHAT_MESSAGES_DELETED_EVENT, deleted);
  };
}

export const ROLE_MEMORY_SYNC_INTERVAL_MS = SYNC_INTERVAL_MS;
