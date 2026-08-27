import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const CHARACTER_TOOL_POLICIES_KEY = "ai_phone_character_tool_policies_v1";
registerKvMigration(CHARACTER_TOOL_POLICIES_KEY);

export type CharacterToolUsage = "chat" | "auto_wake";

export type CharacterToolPermission = {
    chatEnabled: boolean;
    autoWakeEnabled: boolean;
    /** Empty means use the global default tool model. */
    apiConfigId?: string;
    confirmation?: "inherit" | "always" | "never";
};

export type CharacterToolPolicy = {
    characterId: string;
    /** Legacy roles keep their existing globally-enabled tools until first edited. */
    initialized: boolean;
    permissions: Record<string, CharacterToolPermission>;
    createdAt: number;
    updatedAt: number;
};

type CharacterToolPolicyStore = Record<string, CharacterToolPolicy>;

function loadStore(): CharacterToolPolicyStore {
    if (typeof window === "undefined") return {};
    try {
        const raw = kvGet(CHARACTER_TOOL_POLICIES_KEY);
        const parsed = raw ? JSON.parse(raw) as CharacterToolPolicyStore : {};
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function saveStore(store: CharacterToolPolicyStore): void {
    if (typeof window === "undefined") return;
    kvSet(CHARACTER_TOOL_POLICIES_KEY, JSON.stringify(store));
}

export function loadCharacterToolPolicy(characterId: string): CharacterToolPolicy | undefined {
    return loadStore()[characterId];
}

/** New roles start private: no tool is available until the user grants it. */
export function initializeNewCharacterToolPolicy(characterId: string): void {
    const store = loadStore();
    if (store[characterId]) return;
    const now = Date.now();
    store[characterId] = {
        characterId,
        initialized: true,
        permissions: {},
        createdAt: now,
        updatedAt: now,
    };
    saveStore(store);
}

/**
 * Materialize a legacy role policy before its first edit. Existing tools remain
 * chat-enabled, while auto-wake stays opt-in. Newly installed tools remain off.
 */
export function ensureCharacterToolPolicy(characterId: string, existingToolKeys: string[]): CharacterToolPolicy {
    const store = loadStore();
    const current = store[characterId];
    if (current?.initialized) return current;
    const now = Date.now();
    const permissions: Record<string, CharacterToolPermission> = {};
    for (const key of existingToolKeys) {
        permissions[key] = { chatEnabled: true, autoWakeEnabled: false, confirmation: "inherit" };
    }
    const next: CharacterToolPolicy = {
        characterId,
        initialized: true,
        permissions,
        createdAt: current?.createdAt || now,
        updatedAt: now,
    };
    store[characterId] = next;
    saveStore(store);
    return next;
}

export function saveCharacterToolPermission(
    characterId: string,
    toolKey: string,
    patch: Partial<CharacterToolPermission>,
): CharacterToolPolicy {
    const store = loadStore();
    const now = Date.now();
    const current = store[characterId] || {
        characterId,
        initialized: true,
        permissions: {},
        createdAt: now,
        updatedAt: now,
    };
    current.initialized = true;
    const previous = current.permissions[toolKey];
    current.permissions[toolKey] = {
        chatEnabled: patch.chatEnabled ?? previous?.chatEnabled ?? false,
        autoWakeEnabled: patch.autoWakeEnabled ?? previous?.autoWakeEnabled ?? false,
        confirmation: patch.confirmation ?? previous?.confirmation ?? "inherit",
        apiConfigId: "apiConfigId" in patch ? patch.apiConfigId : previous?.apiConfigId,
    };
    current.updatedAt = now;
    store[characterId] = current;
    saveStore(store);
    return current;
}

export function isToolAllowedForCharacter(
    characterId: string,
    toolKey: string,
    usage: CharacterToolUsage = "chat",
): boolean {
    const policy = loadCharacterToolPolicy(characterId);
    // Backwards compatibility for roles created before role-level permissions.
    if (!policy?.initialized) return usage === "chat";
    const permission = policy.permissions[toolKey];
    return usage === "auto_wake" ? permission?.autoWakeEnabled === true : permission?.chatEnabled === true;
}

export function getCharacterToolApiConfigId(characterId: string, toolKey: string): string | undefined {
    return loadCharacterToolPolicy(characterId)?.permissions[toolKey]?.apiConfigId;
}
