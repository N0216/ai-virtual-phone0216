import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";

export type ModelUsageCategory =
    | "manual_chat"
    | "tool"
    | "auto_wake"
    | "image"
    | "audio"
    | "background";

export type ModelUsageEntry = {
    id: string;
    timestamp: number;
    dayKey: string;
    category: ModelUsageCategory;
    model?: string;
    label?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimated: boolean;
};

export type ModelUsageLimitSettings = {
    autoWakeLimitEnabled: boolean;
    autoWakeDailyCalls: number;
    autoWakeDailyTokens: number;
};

export type ModelUsageSummary = {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    hasEstimate: boolean;
};

const MODEL_USAGE_KEY = "ai_phone_model_usage_v1";
const MODEL_USAGE_LIMITS_KEY = "ai_phone_model_usage_limits_v1";
const KEEP_DAYS = 35;

export const DEFAULT_MODEL_USAGE_LIMITS: ModelUsageLimitSettings = {
    autoWakeLimitEnabled: true,
    autoWakeDailyCalls: 20,
    autoWakeDailyTokens: 100_000,
};

registerKvMigration(MODEL_USAGE_KEY);
registerKvMigration(MODEL_USAGE_LIMITS_KEY);

export function localUsageDayKey(at = Date.now()): string {
    const date = new Date(at);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function finiteNonNegative(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function loadEntries(): ModelUsageEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(MODEL_USAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === "object") as ModelUsageEntry[] : [];
    } catch {
        return [];
    }
}

function saveEntries(entries: ModelUsageEntry[]): void {
    if (typeof window === "undefined") return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    kvSet(MODEL_USAGE_KEY, JSON.stringify(entries.filter(entry => entry.timestamp >= cutoff).slice(-5000)));
}

export function loadModelUsageLimits(): ModelUsageLimitSettings {
    if (typeof window === "undefined") return DEFAULT_MODEL_USAGE_LIMITS;
    try {
        const raw = kvGet(MODEL_USAGE_LIMITS_KEY);
        const parsed = raw ? JSON.parse(raw) as Partial<ModelUsageLimitSettings> : {};
        return {
            autoWakeLimitEnabled: parsed.autoWakeLimitEnabled !== false,
            autoWakeDailyCalls: Math.max(1, finiteNonNegative(parsed.autoWakeDailyCalls || DEFAULT_MODEL_USAGE_LIMITS.autoWakeDailyCalls)),
            autoWakeDailyTokens: Math.max(1_000, finiteNonNegative(parsed.autoWakeDailyTokens || DEFAULT_MODEL_USAGE_LIMITS.autoWakeDailyTokens)),
        };
    } catch {
        return DEFAULT_MODEL_USAGE_LIMITS;
    }
}

export function saveModelUsageLimits(settings: ModelUsageLimitSettings): void {
    if (typeof window === "undefined") return;
    kvSet(MODEL_USAGE_LIMITS_KEY, JSON.stringify({
        autoWakeLimitEnabled: settings.autoWakeLimitEnabled,
        autoWakeDailyCalls: Math.max(1, Math.round(settings.autoWakeDailyCalls)),
        autoWakeDailyTokens: Math.max(1_000, Math.round(settings.autoWakeDailyTokens)),
    }));
    window.dispatchEvent(new CustomEvent("model-usage-updated"));
}

export function recordModelUsage(input: {
    category: ModelUsageCategory;
    model?: string;
    label?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimated?: boolean;
    timestamp?: number;
}): ModelUsageEntry | null {
    if (typeof window === "undefined") return null;
    const timestamp = input.timestamp || Date.now();
    const promptTokens = finiteNonNegative(input.promptTokens);
    const completionTokens = finiteNonNegative(input.completionTokens);
    const suppliedTotal = finiteNonNegative(input.totalTokens);
    const entry: ModelUsageEntry = {
        id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp,
        dayKey: localUsageDayKey(timestamp),
        category: input.category,
        model: input.model?.trim() || undefined,
        label: input.label?.trim() || undefined,
        promptTokens,
        completionTokens,
        totalTokens: suppliedTotal || promptTokens + completionTokens,
        estimated: input.estimated === true,
    };
    const entries = loadEntries();
    entries.push(entry);
    saveEntries(entries);
    window.dispatchEvent(new CustomEvent("model-usage-updated", { detail: entry }));
    return entry;
}

export function getModelUsageEntries(dayKey?: string): ModelUsageEntry[] {
    const entries = loadEntries();
    return dayKey ? entries.filter(entry => entry.dayKey === dayKey) : entries;
}

export function summarizeModelUsage(entries: ModelUsageEntry[]): ModelUsageSummary {
    return entries.reduce<ModelUsageSummary>((summary, entry) => ({
        calls: summary.calls + 1,
        promptTokens: summary.promptTokens + finiteNonNegative(entry.promptTokens),
        completionTokens: summary.completionTokens + finiteNonNegative(entry.completionTokens),
        totalTokens: summary.totalTokens + finiteNonNegative(entry.totalTokens),
        hasEstimate: summary.hasEstimate || entry.estimated,
    }), { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, hasEstimate: false });
}

export function getTodayModelUsage(category?: ModelUsageCategory): ModelUsageSummary {
    const entries = getModelUsageEntries(localUsageDayKey());
    return summarizeModelUsage(category ? entries.filter(entry => entry.category === category) : entries);
}

export function canStartAutoWakeModelCall(): { ok: boolean; reason?: string; usage: ModelUsageSummary; limits: ModelUsageLimitSettings } {
    const limits = loadModelUsageLimits();
    const usage = getTodayModelUsage("auto_wake");
    if (!limits.autoWakeLimitEnabled) return { ok: true, usage, limits };
    if (usage.calls >= limits.autoWakeDailyCalls) {
        return { ok: false, reason: "今日自动醒来调用次数已达上限", usage, limits };
    }
    if (usage.totalTokens >= limits.autoWakeDailyTokens) {
        return { ok: false, reason: "今日自动醒来 Token 已达上限", usage, limits };
    }
    return { ok: true, usage, limits };
}

export function clearModelUsage(): void {
    if (typeof window === "undefined") return;
    kvRemove(MODEL_USAGE_KEY);
    window.dispatchEvent(new CustomEvent("model-usage-updated"));
}

export function usageCategoryForChatRequest(appId = "chat", appTags?: string[]): ModelUsageCategory {
    const tags = new Set(appTags || []);
    if (tags.has("idle_wake") || tags.has("timed_wake") || tags.has("user_timed_wake") || tags.has("followup") || tags.has("period_care")) {
        return "auto_wake";
    }
    if (appId === "chat" || appId === "group_chat") return "manual_chat";
    return "background";
}

export function estimateUsageFromText(requestChars: number, responseChars: number) {
    const promptTokens = Math.max(1, Math.ceil(Math.max(0, requestChars) / 3));
    const completionTokens = Math.max(1, Math.ceil(Math.max(0, responseChars) / 3));
    return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}
