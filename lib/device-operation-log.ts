import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { redactSensitiveLogText } from "./log-redaction";

export const DEVICE_OPERATION_LOG_KEY = "ai_phone_device_operation_log_v1";
const MAX_DEVICE_OPERATION_LOGS = 500;
registerKvMigration(DEVICE_OPERATION_LOG_KEY);

export type DeviceOperationStatus = "running" | "succeeded" | "failed" | "denied" | "cancelled";

export type DeviceOperationLogEntry = {
    id: string;
    taskId?: string;
    actorType: "role" | "eiren" | "deepseek" | "system";
    actorId?: string;
    actorName?: string;
    source: "chat" | "auto_wake" | "execution_assistant" | "custom_app" | "unknown";
    toolName: string;
    /** The actual leaf capability remains visible even when an aggregate grant authorized it. */
    capabilityId?: string;
    authorizationBasis?: "user_view_read";
    argumentKeys: string[];
    status: DeviceOperationStatus;
    resultSummary?: string;
    error?: string;
    startedAt: string;
    finishedAt?: string;
};

export type DeviceOperationLogStore = {
    load(): DeviceOperationLogEntry[];
    save(entries: DeviceOperationLogEntry[]): void | Promise<void>;
    now(): string;
    makeId(): string;
};

function defaultStore(): DeviceOperationLogStore {
    return {
        load: loadDeviceOperationLogs,
        save: entries => kvSet(DEVICE_OPERATION_LOG_KEY, JSON.stringify(entries.slice(-MAX_DEVICE_OPERATION_LOGS))),
        now: () => new Date().toISOString(),
        makeId: () => `device_op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    };
}

export function loadDeviceOperationLogs(): DeviceOperationLogEntry[] {
    if (typeof window === "undefined") return [];
    try {
        const parsed = JSON.parse(kvGet(DEVICE_OPERATION_LOG_KEY) || "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        const staleBefore = Date.now() - 60 * 60 * 1000;
        return (parsed.filter(Boolean) as DeviceOperationLogEntry[]).map(entry => (
            entry.status === "running" && Date.parse(entry.startedAt) < staleBefore
                ? { ...entry, status: "failed", error: "应用退出或操作超过一小时未完成" }
                : entry
        ));
    } catch {
        return [];
    }
}

export async function startDeviceOperation(
    input: Omit<DeviceOperationLogEntry, "id" | "status" | "startedAt" | "argumentKeys"> & { argumentKeys?: string[] },
    suppliedStore?: DeviceOperationLogStore,
): Promise<DeviceOperationLogEntry> {
    const store = suppliedStore || defaultStore();
    const entry: DeviceOperationLogEntry = {
        ...input,
        id: store.makeId(),
        status: "running",
        argumentKeys: [...new Set(input.argumentKeys || [])].sort(),
        startedAt: store.now(),
    };
    await store.save([...store.load(), entry].slice(-MAX_DEVICE_OPERATION_LOGS));
    return entry;
}

export async function finishDeviceOperation(
    id: string,
    patch: Pick<DeviceOperationLogEntry, "status"> & Partial<Pick<DeviceOperationLogEntry, "resultSummary" | "error">>,
    suppliedStore?: DeviceOperationLogStore,
): Promise<void> {
    const store = suppliedStore || defaultStore();
    const finishedAt = store.now();
    const entries = store.load().map(entry => entry.id === id ? {
        ...entry,
        ...patch,
        resultSummary: patch.resultSummary ? redactSensitiveLogText(patch.resultSummary).slice(0, 300) : undefined,
        error: patch.error ? redactSensitiveLogText(patch.error).slice(0, 500) : undefined,
        finishedAt,
    } : entry);
    await store.save(entries);
}

export function summarizeOperationResult(value: unknown): string {
    const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return redactSensitiveLogText(text).replace(/\s+/g, " ").trim().slice(0, 300);
}
