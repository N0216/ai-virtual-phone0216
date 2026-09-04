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
import { collectRoleCloudEvents, type RoleCloudEvent } from "./role-event-sync";
import { batchCallTranscriptChunks } from "./call-cloud-sync";
import { commitCallTranscriptVersion } from "./call-cloud-commit";
import {
  isPersonalPushCloudActive,
  loadPersonalPushCloudState,
  personalPushFetch,
  PERSONAL_PUSH_SCHEMA_VERSION,
} from "./personal-push-cloud";
import { redactSensitiveLogText } from "./log-redaction";

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
  syncedEventVersions: Record<string, string>;
  lastSyncedAt?: string;
  lastAttemptAt?: string;
  status?: "idle" | "syncing" | "success" | "failed";
  lastError?: string;
};

export type RoleMemorySyncStatus = Pick<SyncState, "lastSyncedAt" | "lastAttemptAt" | "status" | "lastError">;
export const ROLE_MEMORY_SYNC_STATUS_EVENT = "ai-phone:role-memory-sync-status";

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
      syncedEventVersions: parsed.syncedEventVersions && typeof parsed.syncedEventVersions === "object"
        ? parsed.syncedEventVersions : {},
      lastSyncedAt: typeof parsed.lastSyncedAt === "string" ? parsed.lastSyncedAt : undefined,
      lastAttemptAt: typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : undefined,
      status: ["idle", "syncing", "success", "failed"].includes(parsed.status || "")
        ? parsed.status as SyncState["status"] : "idle",
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
    };
  } catch {
    return {
      backfilledBySession: {},
      pendingDeletes: [],
      syncedMessageVersions: {},
      syncedMemoryVersionsByRole: {},
      syncedEventVersions: {},
    };
  }
}

function saveSyncState(state: SyncState): void {
  kvSet(SYNC_STATE_KEY, JSON.stringify(state));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(ROLE_MEMORY_SYNC_STATUS_EVENT, { detail: getRoleMemorySyncStatus(state) }));
  }
}

function getRoleMemorySyncStatus(state = loadSyncState()): RoleMemorySyncStatus {
  return {
    lastSyncedAt: state.lastSyncedAt,
    lastAttemptAt: state.lastAttemptAt,
    status: state.status || "idle",
    lastError: state.lastError,
  };
}

export function loadRoleMemorySyncStatus(): RoleMemorySyncStatus {
  return getRoleMemorySyncStatus();
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

function syncableMessage(message: ChatMessage): boolean {
  if (!message.sessionId || !["user", "assistant", "system"].includes(message.role)) return false;
  if (message.role === "system" && (message.mediaType === "system_instruction" || message.mediaType === "tool_notice")) return false;
  if (message.mediaType === "tool_call" || message.mediaType === "tool_result") return false;
  return true;
}

function serializeMessage(message: ChatMessage, session: ChatSession, role: { roleId: string; roleName: string }) {
  const visibleContent = message.content?.trim() || "";
  const stateValues = message.freshStateValues ?? message.stateValues ?? [];
  const stateSummary = stateValues.length > 0
    ? `状态数值：${stateValues.map(item => `${item.name}=${item.value}`).join("；")}`
    : "";
  const content = redactSensitiveLogText([
    visibleContent,
    message.innerMonologue?.trim() ? `内心独白：${message.innerMonologue.trim()}` : "",
    message.statusPanel?.trim() ? `状态栏：${message.statusPanel.trim()}` : "",
    stateSummary,
    !visibleContent && !message.innerMonologue?.trim() && !message.statusPanel?.trim() && !stateSummary
      ? getChatMessagePreview(message) || "[非文字消息]"
      : "",
  ].filter(Boolean).join("\n"));
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
      ...(message.innerMonologue?.trim() ? { containsInnerMonologue: true } : {}),
      ...(message.statusPanel?.trim() ? { containsStatusPanel: true } : {}),
      ...(stateValues.length > 0 ? { stateValues } : {}),
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
    innerMonologue: message.innerMonologue || "",
    statusPanel: message.statusPanel || "",
    stateValues: message.stateValues || [],
    freshStateValues: message.freshStateValues || [],
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

function eventVersion(entry: RoleCloudEvent): string {
  const { transcriptChunks: _transcriptChunks, ...versionedEntry } = entry;
  return stableHash(JSON.stringify(versionedEntry));
}

const EVENT_KEY_SEPARATOR = "\u001f";

function eventKey(entry: { roleId: string; sourceType: string; sourceId: string }): string {
  return [entry.roleId, entry.sourceType, entry.sourceId].join(EVENT_KEY_SEPARATOR);
}

async function syncCallTranscript(entry: RoleCloudEvent): Promise<void> {
  if (entry.sourceType !== "call") return;
  const chunks = entry.transcriptChunks || [];
  const transcriptVersion = String(entry.metadata?.transcriptVersion || "");
  if (!transcriptVersion) throw new Error("通话转录版本无效");
  const batches = batchCallTranscriptChunks(chunks);
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const response = await personalPushFetch("role-call-transcript-sync", {
      method: "POST",
      body: JSON.stringify({
        roleId: entry.roleId,
        callId: entry.sourceId,
        transcriptVersion,
        totalChunks: chunks.length,
        chunks: batch,
        complete: index === batches.length - 1,
      }),
    }).catch(() => null);
    if (!response?.ok) throw new Error("完整通话转录分片上传失败");
    const data = await response.json().catch(() => null) as { ok?: boolean } | null;
    if (!data?.ok) throw new Error("完整通话转录分片写入失败");
  }
}

async function switchRoleEvents(entries: RoleCloudEvent[], deletes: Array<{ roleId: string; sourceType: string; sourceId: string }>): Promise<void> {
  const response = await personalPushFetch("role-events-sync", {
    method: "POST",
    body: JSON.stringify({
      events: entries.map(({ transcriptChunks: _transcriptChunks, ...entry }) => entry),
      deletes,
    }),
  }).catch(() => null);
  if (!response?.ok) throw new Error("梦境、剧情或其他角色资料上传失败");
  const data = await response.json().catch(() => null) as { ok?: boolean } | null;
  if (!data?.ok) throw new Error("梦境、剧情或其他角色资料写入失败");
}

async function cleanupOldCallTranscriptVersions(entry: RoleCloudEvent): Promise<void> {
  const transcriptVersion = String(entry.metadata?.transcriptVersion || "");
  const response = await personalPushFetch("role-call-transcript-finalize", {
    method: "POST",
    body: JSON.stringify({ roleId: entry.roleId, callId: entry.sourceId, transcriptVersion }),
  }).catch(() => null);
  if (!response?.ok) throw new Error("旧版通话转录清理失败");
  const data = await response.json().catch(() => null) as { ok?: boolean } | null;
  if (!data?.ok) throw new Error("旧版通话转录清理未完成");
}

async function syncRoleEvents(state: SyncState): Promise<void> {
  const events = await collectRoleCloudEvents();
  const currentVersions = Object.fromEntries(events.map(entry => [
    eventKey(entry),
    eventVersion(entry),
  ]));
  const changed = events.filter(entry => {
    const key = eventKey(entry);
    return state.syncedEventVersions[key] !== currentVersions[key];
  });
  const changedCalls = changed.filter(entry => entry.sourceType === "call");
  const changedOther = changed.filter(entry => entry.sourceType !== "call");
  for (const entry of changedCalls) {
    await commitCallTranscriptVersion({
      uploadNewVersion: () => syncCallTranscript(entry),
      switchParentVersion: () => switchRoleEvents([entry], []),
      cleanupOldVersions: () => cleanupOldCallTranscriptVersions(entry),
    });
    state.syncedEventVersions[eventKey(entry)] = currentVersions[eventKey(entry)];
  }
  const active = new Set(Object.keys(currentVersions));
  const deleted = Object.keys(state.syncedEventVersions)
    .filter(key => !active.has(key))
    .map(key => key.split(EVENT_KEY_SEPARATOR))
    .filter(parts => parts.length === 3)
    .map(([roleId, sourceType, sourceId]) => ({ roleId, sourceType, sourceId }));
  const calls = Math.max(Math.ceil(changedOther.length / 80), Math.ceil(deleted.length / 160), 1);
  for (let index = 0; index < calls; index += 1) {
    const chunk = changedOther.slice(index * 80, (index + 1) * 80);
    const deleteChunk = deleted.slice(index * 160, (index + 1) * 160);
    if (chunk.length === 0 && deleteChunk.length === 0) continue;
    await switchRoleEvents(chunk, deleteChunk);
    for (const entry of chunk) {
      const key = eventKey(entry);
      state.syncedEventVersions[key] = currentVersions[key];
    }
    for (const entry of deleteChunk) delete state.syncedEventVersions[eventKey(entry)];
  }
  // Keep local bookkeeping bounded. Cloud rows remain the authoritative archive.
  state.syncedEventVersions = Object.fromEntries(
    Object.entries(state.syncedEventVersions).filter(([key]) => active.has(key)).slice(-5000),
  );
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

async function pullRoleContext(roleId: string, cache: ContextCache): Promise<boolean> {
  const response = await personalPushFetch("role-context", { method: "GET" }, { roleId }).catch(() => null);
  if (!response?.ok) return false;
  const data = await response.json().catch(() => null) as {
    ok?: boolean;
    handoff?: RoleCloudContext["handoff"];
    memories?: RoleCloudContext["memories"];
    officialMessages?: RoleCloudContext["officialMessages"];
  } | null;
  if (!data?.ok) return false;
  cache[roleId] = {
    fetchedAt: new Date().toISOString(),
    handoff: data.handoff || null,
    memories: Array.isArray(data.memories) ? data.memories : [],
    officialMessages: Array.isArray(data.officialMessages) ? data.officialMessages : [],
  };
  return true;
}

/**
 * Refresh one role immediately before building a model prompt. This is a plain
 * personal-cloud read, not an AI tool call. It closes the scheduler timing gap
 * when the official GPT has just written a handoff and the user switches apps
 * before the next two-minute background sync.
 */
export async function refreshRoleCloudContextBeforeReply(roleId: string): Promise<boolean> {
  // Personal cloud is optional. Only fail a reply when it is configured but its
  // latest context cannot be fetched; an unconfigured phone keeps working normally.
  if (!roleId || !personalRoleSyncReady()) return true;
  const cache = loadContextCache();
  const refreshed = await pullRoleContext(roleId, cache);
  if (!refreshed) return false;
  kvSet(CONTEXT_CACHE_KEY, JSON.stringify(cache));
  return true;
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
    if (!response?.ok) throw new Error("长期记忆上传失败");
    const data = await response.json().catch(() => null) as { ok?: boolean } | null;
    if (!data?.ok) throw new Error("长期记忆写入失败");
  }
  state.syncedMemoryVersionsByRole[roleId] = currentVersions;
}

let running = false;

export async function syncRoleMemoryNow(): Promise<void> {
  if (running || !isChatStorageHydrated() || !personalRoleSyncReady()) return;
  running = true;
  let state: SyncState | null = null;
  try {
    state = loadSyncState();
    state.lastAttemptAt = new Date().toISOString();
    state.status = "syncing";
    state.lastError = undefined;
    saveSyncState(state);
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
      })).filter(item => state!.syncedMessageVersions[item.key] !== item.version);
      let uploaded = true;
      for (let index = 0; index < changed.length; index += 100) {
        const chunk = changed.slice(index, index + 100);
        if (!await sendBatch(chunk.map(item => serializeMessage(item.message, session, role)), [])) {
          throw new Error("普通聊天上传失败");
        }
        for (const item of chunk) state.syncedMessageVersions[item.key] = item.version;
      }
      if (uploaded) {
        state.backfilledBySession[session.id] = alreadyBackfilled + older.length;
      }
    }

    if (state.pendingDeletes.length > 0 && await sendBatch([], state.pendingDeletes.slice(0, 240))) {
      state.pendingDeletes = state.pendingDeletes.slice(240);
    } else if (state.pendingDeletes.length > 0) {
      throw new Error("已删除聊天的云端清理失败");
    }

    const memoryRoleIds = await getAllCharacterIdsWithMemories();
    for (const roleId of memoryRoleIds) roles.add(roleId);
    for (const roleId of Object.keys(state.syncedMemoryVersionsByRole)) roles.add(roleId);
    const characters = loadCharacters();
    for (const roleId of roles) {
      const roleName = characters.find(character => character.id === roleId)?.name || roleId;
      await syncLocalMemories(roleId, roleName, state);
    }
    await syncRoleEvents(state);
    state.lastSyncedAt = new Date().toISOString();
    state.status = "success";
    state.lastError = undefined;
    saveSyncState(state);

    const cache = loadContextCache();
    for (const roleId of roles) {
      if (!await pullRoleContext(roleId, cache)) throw new Error("角色交接内容拉取失败");
    }
    kvSet(CONTEXT_CACHE_KEY, JSON.stringify(cache));
  } catch (error) {
    if (state) {
      state.status = "failed";
      state.lastError = error instanceof Error ? error.message.slice(0, 160) : "个人云同步失败";
      saveSyncState(state);
    }
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
