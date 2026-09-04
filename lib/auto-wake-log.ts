import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { redactSensitiveLogText } from "./log-redaction";

export type AutoWakeLogEntry = {
    id: string;
    timestamp: number;
    characterName: string;
    trigger: string;
    model?: string;
    decision: "sent" | "silent" | "skipped" | "failed";
    detail: string;
};

const AUTO_WAKE_LOG_KEY = "ai_phone_auto_wake_logs_v1";
const MAX_LOGS = 300;
registerKvMigration(AUTO_WAKE_LOG_KEY);

export function loadAutoWakeLogs(): AutoWakeLogEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(AUTO_WAKE_LOG_KEY) || "[]") as unknown;
        return Array.isArray(parsed) ? (parsed.filter(Boolean) as AutoWakeLogEntry[]).map(entry => ({
            ...entry,
            characterName: redactSensitiveLogText(String(entry.characterName || "角色")),
            trigger: redactSensitiveLogText(String(entry.trigger || "自动醒来")),
            model: entry.model ? redactSensitiveLogText(String(entry.model)) : undefined,
            detail: redactSensitiveLogText(String(entry.detail || "")),
        })) : [];
    } catch {
        return [];
    }
}

export function recordAutoWakeLog(input: Omit<AutoWakeLogEntry, "id" | "timestamp"> & { timestamp?: number }): void {
    if (typeof window === "undefined") return;
    const timestamp = input.timestamp || Date.now();
    const next: AutoWakeLogEntry = {
        id: `${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp,
        characterName: redactSensitiveLogText(input.characterName.trim()) || "角色",
        trigger: redactSensitiveLogText(input.trigger.trim()) || "自动醒来",
        model: input.model ? redactSensitiveLogText(input.model.trim()) || undefined : undefined,
        decision: input.decision,
        detail: redactSensitiveLogText(input.detail.trim()),
    };
    kvSet(AUTO_WAKE_LOG_KEY, JSON.stringify([...loadAutoWakeLogs(), next].slice(-MAX_LOGS)));
    window.dispatchEvent(new CustomEvent("auto-wake-log-updated", { detail: next }));
}
