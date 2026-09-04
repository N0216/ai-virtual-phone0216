export const USER_VIEW_READ_CAPABILITY_ID = "user_view_read";

export type UserViewReadCall = {
    name: string;
    args?: Record<string, unknown>;
};

export type UserViewReadRegistration = {
    toolName: string;
    capabilityId: string;
    localExecution: boolean;
    allowedOps?: readonly string[];
};

const ROLE_PHONE_REFERENCE = /(?:aiphonecheckphonedb|ai_phone_checkphone_events_|checkphone-settings|checkphone:|\bvirtual_phone\b|角色手机|查手机)/iu;

/** A complete deny-domain: owner visibility never delegates the role phone. */
export function isRolePhoneReference(value: unknown): boolean {
    return typeof value === "string" && ROLE_PHONE_REFERENCE.test(value);
}

function containsRolePhoneReference(value: unknown, depth = 0): boolean {
    if (depth > 8 || value == null) return false;
    if (typeof value === "string") return isRolePhoneReference(value);
    if (Array.isArray(value)) return value.some(item => containsRolePhoneReference(item, depth + 1));
    if (typeof value === "object") return Object.entries(value as Record<string, unknown>)
        .some(([key, item]) => isRolePhoneReference(key) || containsRolePhoneReference(item, depth + 1));
    return false;
}

export function isRolePhoneLocalDataPath(path: string): boolean {
    try {
        return isRolePhoneReference(decodeURIComponent(path).toLowerCase());
    } catch {
        return isRolePhoneReference(path.toLowerCase());
    }
}

export function isBroadLocalDataScopeContainingRolePhone(path: string): boolean {
    const normalized = `/${path.replace(/^\/+|\/+$/g, "")}`.toLowerCase();
    return ["/creative", "/creative/indexeddb", "/creative/kv", "/cache", "/cache/kv", "/cache/localstorage"].includes(normalized);
}

export function isRolePhoneUserViewReadCallDenied(call: UserViewReadCall): boolean {
    const path = typeof call.args?.path === "string" ? call.args.path : "";
    return containsRolePhoneReference(call.args)
        || (call.name === "搜索资料记录" && isBroadLocalDataScopeContainingRolePhone(path));
}

function rolePhoneRecordIdentity(record: Record<string, unknown>): string {
    return [
        record.source_type, record.sourceType, record.dbName, record.database,
        record.path, record.key, record.id, record.name, record.title,
        record.source, record.sourceDetail, record.appId, record.app_id,
        record.applicationId, record.moduleId, record.route, record.url,
    ].filter(value => typeof value === "string").join(" ");
}

/** Removes role-phone directory entries/records and masks residual markers. */
export function sanitizeUserViewReadResult(value: unknown, depth = 0): unknown {
    if (depth > 10) return null;
    if (typeof value === "string") return isRolePhoneReference(value) ? "[角色手机数据不可读]" : value;
    if (Array.isArray(value)) {
        return value
            .filter(item => !(item && typeof item === "object" && !Array.isArray(item)
                && isRolePhoneReference(rolePhoneRecordIdentity(item as Record<string, unknown>))))
            .map(item => sanitizeUserViewReadResult(item, depth + 1));
    }
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (isRolePhoneReference(rolePhoneRecordIdentity(record))) return "[角色手机数据不可读]";
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, sanitizeUserViewReadResult(child, depth + 1)]));
}

/**
 * Registry for the owner's long-lived Eiren read grant. New owner-visible read
 * surfaces must be added here explicitly; registration is never inferred from
 * a tool description or a user-controlled name.
 */
export const USER_VIEW_READ_REGISTRY: readonly UserViewReadRegistration[] = [
    { toolName: "查看小手机设置", capabilityId: "phone_management", localExecution: true },
    { toolName: "查看设备操作日志", capabilityId: "phone_management", localExecution: true },
    { toolName: "列出可查看的互动", capabilityId: "phone_interaction_read", localExecution: true },
    { toolName: "查看最近聊天", capabilityId: "phone_interaction_read", localExecution: true },
    { toolName: "查看通话内容", capabilityId: "phone_interaction_read", localExecution: true },
    { toolName: "列出资料目录", capabilityId: "local_data_library", localExecution: true },
    { toolName: "读取资料文件", capabilityId: "local_data_library", localExecution: true },
    { toolName: "查看资料字段", capabilityId: "local_data_library", localExecution: true },
    { toolName: "搜索资料记录", capabilityId: "local_data_library", localExecution: true },
    { toolName: "读取资料记录", capabilityId: "local_data_library", localExecution: true },
    { toolName: "角色电脑", capabilityId: "agent_computer", localExecution: true, allowedOps: ["read", "list"] },

    // Owner-cloud reads used directly by Eiren. They are registered here so
    // additions remain deliberate and can share the same policy vocabulary.
    { toolName: "list_roles", capabilityId: "role_cloud_read", localExecution: false },
    { toolName: "read_recent_chat", capabilityId: "role_cloud_read", localExecution: false },
    { toolName: "get_latest_handoff", capabilityId: "role_cloud_read", localExecution: false },
    { toolName: "list_personal_sources", capabilityId: "role_cloud_read", localExecution: false },
    { toolName: "search_personal_records", capabilityId: "role_cloud_read", localExecution: false },
    { toolName: "read_call_transcript", capabilityId: "role_cloud_read", localExecution: false },
    { toolName: "read_query_history", capabilityId: "role_cloud_read", localExecution: false },
    { toolName: "search_shared_memory", capabilityId: "role_cloud_read", localExecution: false },
    { toolName: "list_execution_tasks", capabilityId: "execution_handoff_read", localExecution: false },
    { toolName: "read_execution_task", capabilityId: "execution_handoff_read", localExecution: false },
];

export function findUserViewReadRegistration(call: UserViewReadCall): UserViewReadRegistration | null {
    const candidates = USER_VIEW_READ_REGISTRY.filter(item => item.toolName === call.name);
    for (const item of candidates) {
        if (!item.allowedOps) return item;
        const op = typeof call.args?.op === "string" ? call.args.op.trim() : "";
        if (item.allowedOps.includes(op)) return item;
    }
    return null;
}

export function isRegisteredUserViewReadToolName(name: string): boolean {
    return USER_VIEW_READ_REGISTRY.some(item => item.toolName === name);
}

export function listLocalUserViewReadToolNames(): string[] {
    return [...new Set(USER_VIEW_READ_REGISTRY.filter(item => item.localExecution).map(item => item.toolName))];
}

export function resolveUserViewReadPermission(input: {
    call: UserViewReadCall;
    grantEnabled: boolean;
    taskPermissionScope?: readonly string[];
}): { allowed: boolean; registration: UserViewReadRegistration | null; reason?: "not_registered" | "grant_revoked" | "outside_task_scope" | "role_phone_excluded" } {
    const registration = findUserViewReadRegistration(input.call);
    if (!registration) return { allowed: false, registration: null, reason: "not_registered" };
    if (isRolePhoneUserViewReadCallDenied(input.call)) {
        return { allowed: false, registration, reason: "role_phone_excluded" };
    }
    if (!input.grantEnabled) return { allowed: false, registration, reason: "grant_revoked" };
    if (input.taskPermissionScope && !input.taskPermissionScope.includes(input.call.name)) {
        return { allowed: false, registration, reason: "outside_task_scope" };
    }
    return { allowed: true, registration };
}

export function isAlwaysForbiddenExecutionAssistantToolName(name: string): boolean {
    return /(工具箱|添加REST|更新REST|删除REST|添加组合工具|更新组合工具|删除组合工具|权限|角色关系|感情表达|写入.{0,8}记忆|保存.{0,8}记忆|save[_ -]?.*memory|append[_ -]?role[_ -]?messages|save[_ -]?role[_ -]?handoff)/i.test(name);
}

export function isRolePhoneExecutionTaskDenied(task: { intent: string; permission_scope: readonly string[] }): boolean {
    return isRolePhoneReference(task.intent) || task.permission_scope.some(isRolePhoneReference);
}
