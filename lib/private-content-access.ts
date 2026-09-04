import type { StoredCallRecord } from "./chat-db";
import type { ChatContact, ChatMessage, ChatSession } from "./chat-storage";

/**
 * Boundary for content that may later move to a private service.
 *
 * The current adapter deliberately keeps the existing AiPhoneChatDB as the
 * authority. Consumers must depend on this interface rather than importing the
 * mixed IndexedDB stores directly, so the backend can be replaced without
 * changing permission and safe-projection code.
 */
export type PrivateContentAccess = {
    listSessions(): Promise<ChatSession[]>;
    listContacts(): Promise<ChatContact[]>;
    listMessages(sessionId: string): Promise<ChatMessage[]>;
    listCallRecords(sessionId: string): Promise<StoredCallRecord[]>;
    characterLabels(): Promise<Record<string, string>>;
    /** Durable private-service access control will replace this compatibility gate. */
    canReadSession(session: ChatSession, characterId?: string): Promise<boolean>;
};

function isExplicitlyDeniedToEiren(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if (record.allowEirenView === false || record.eirenVisible === false || record.ownerViewReadable === false) return true;
    const access = String(record.accessDecision ?? record.access ?? "").toLowerCase();
    const visibility = String(record.visibility ?? "").toLowerCase();
    return ["deny", "denied", "locked", "blocked", "hidden"].includes(access)
        || ["locked", "blocked", "hidden", "private_to_owner"].includes(visibility);
}

export async function createLegacyPrivateContentAccess(): Promise<PrivateContentAccess> {
    const [chatDbModule, callRecordModule, characterModule] = await Promise.all([
        import("./chat-db"),
        import("./call-record-storage"),
        import("./character-storage"),
    ]);
    return {
        listSessions: () => chatDbModule.chatDb.sessions.toArray(),
        listContacts: () => chatDbModule.chatDb.contacts.toArray(),
        listMessages: sessionId => chatDbModule.chatDb.messages.where("sessionId").equals(sessionId).sortBy("createdAt"),
        listCallRecords: sessionId => callRecordModule.loadLocalCallRecords(sessionId),
        characterLabels: async () => Object.fromEntries(characterModule.loadCharacters().map(item => [item.id, item.name])),
        // Accept forward-compatible object-level deny flags without changing the
        // existing IndexedDB schema. A future private service will own this gate.
        canReadSession: async session => !isExplicitlyDeniedToEiren(session),
    };
}
