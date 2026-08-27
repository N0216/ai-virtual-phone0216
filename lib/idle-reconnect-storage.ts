// 冷场重连：用户超过 X 时间没有发消息时，角色主动发一次消息。
// 计时锚定"用户最后一条消息"；角色的重连消息不重置计时，用连发计数控制；
// 用户回复后计数清零，周期重新开始。每个角色一条规则。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const IDLE_RECONNECT_RULES_KEY = "ai_phone_idle_reconnect_rules_v1";
registerKvMigration(IDLE_RECONNECT_RULES_KEY);

/** 连发上限：用户不回复时最多主动发这么多次，回复后清零 */
export const IDLE_RECONNECT_MAX_CONSECUTIVE = 3;
export const DEFAULT_IDLE_RECONNECT_MAX_CHECKS_PER_DAY = 8;
export const DEFAULT_IDLE_RECONNECT_MAX_MESSAGES_PER_DAY = 3;
export const DEFAULT_IDLE_RECONNECT_DAILY_TOKEN_BUDGET = 30_000;

export type IdleReconnectDailyUsage = {
    dayKey: string;
    checks: number;
    messages: number;
    estimatedTokens: number;
};

export type IdleReconnectRule = {
    id: string;
    characterId: string;
    sessionId: string;
    /** 沉默阈值（分钟），1 分钟 ~ 72 小时 */
    intervalMinutes: number;
    /** 用户附加意图（可空） */
    intent: string;
    /** 留空时沿用该角色聊天绑定的主模型。 */
    wakeApiConfigId?: string;
    maxChecksPerDay?: number;
    maxMessagesPerDay?: number;
    dailyTokenBudget?: number;
    dailyUsage?: IdleReconnectDailyUsage;
    /** 自上次用户消息以来已连发次数 */
    consecutiveCount: number;
    /** 上次触发时刻（毫秒） */
    lastFiredAt?: number;
    /** 上次完成醒来检查的时刻；静默检查也会记录，防止立即重复消耗。 */
    lastCheckedAt?: number;
    /** 当前这次主动生成被用户停止后，短时间内不再重试 */
    suppressedUntil?: number;
    createdAt: number;
};

function isRule(value: unknown): value is IdleReconnectRule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<IdleReconnectRule>;
    return typeof item.id === "string"
        && typeof item.characterId === "string"
        && typeof item.sessionId === "string"
        && typeof item.intervalMinutes === "number"
        && typeof item.intent === "string"
        && typeof item.consecutiveCount === "number"
        && typeof item.createdAt === "number";
}

function localDayKey(atMs: number): string {
    const date = new Date(atMs);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function getIdleReconnectDailyUsage(rule: IdleReconnectRule, atMs = Date.now()): IdleReconnectDailyUsage {
    const dayKey = localDayKey(atMs);
    if (rule.dailyUsage?.dayKey === dayKey) return rule.dailyUsage;
    return { dayKey, checks: 0, messages: 0, estimatedTokens: 0 };
}

export function getIdleReconnectLimits(rule: IdleReconnectRule) {
    return {
        maxChecksPerDay: Math.max(1, rule.maxChecksPerDay ?? DEFAULT_IDLE_RECONNECT_MAX_CHECKS_PER_DAY),
        maxMessagesPerDay: Math.max(1, rule.maxMessagesPerDay ?? DEFAULT_IDLE_RECONNECT_MAX_MESSAGES_PER_DAY),
        dailyTokenBudget: Math.max(1_000, rule.dailyTokenBudget ?? DEFAULT_IDLE_RECONNECT_DAILY_TOKEN_BUDGET),
    };
}

/** 连发限制按当天计算；隔天可以重新醒来，不会因为前一天没回复永久停住。 */
export function getEffectiveIdleReconnectConsecutive(
    rule: IdleReconnectRule,
    lastUserAt: number,
    atMs = Date.now(),
): number {
    if (!rule.lastFiredAt || rule.lastFiredAt <= lastUserAt) return 0;
    return localDayKey(rule.lastFiredAt) === localDayKey(atMs) ? rule.consecutiveCount : 0;
}

export function canRunIdleReconnect(rule: IdleReconnectRule, atMs = Date.now()): { ok: boolean; reason?: string } {
    const usage = getIdleReconnectDailyUsage(rule, atMs);
    const limits = getIdleReconnectLimits(rule);
    if (usage.checks >= limits.maxChecksPerDay) return { ok: false, reason: "今日醒来检查次数已达上限" };
    if (usage.messages >= limits.maxMessagesPerDay) return { ok: false, reason: "今日主动消息次数已达上限" };
    if (usage.estimatedTokens >= limits.dailyTokenBudget) return { ok: false, reason: "今日后台 Token 预算已达上限" };
    return { ok: true };
}

export function loadIdleReconnectRules(): IdleReconnectRule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(IDLE_RECONNECT_RULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter(isRule) : [];
    } catch {
        return [];
    }
}

function saveRules(rules: IdleReconnectRule[]): void {
    if (typeof window === "undefined") return;
    kvSet(IDLE_RECONNECT_RULES_KEY, JSON.stringify(rules.slice(0, 100)));
}

/** 每角色一条：同角色再建即替换。 */
export function upsertIdleReconnectRule(rule: IdleReconnectRule): void {
    const rest = loadIdleReconnectRules().filter(item => item.characterId !== rule.characterId);
    saveRules([...rest, rule]);
}

export function removeIdleReconnectRule(id: string): void {
    saveRules(loadIdleReconnectRules().filter(item => item.id !== id));
}

/** 记一次触发（本地触发或服务端触发回端合并时都调用）。 */
export function markIdleReconnectFired(id: string, firedAtMs: number): void {
    markIdleReconnectChecked(id, firedAtMs, true, 0);
}

/** 记录一次真实检查。只有确实产生可见消息时才计入连发与消息上限。 */
export function markIdleReconnectChecked(
    id: string,
    checkedAtMs: number,
    hasVisible: boolean,
    estimatedTokens: number,
): void {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.id === id);
    if (!rule) return;
    if (!rule.lastCheckedAt || checkedAtMs > rule.lastCheckedAt) {
        rule.lastCheckedAt = checkedAtMs;
        const usage = getIdleReconnectDailyUsage(rule, checkedAtMs);
        rule.dailyUsage = {
            ...usage,
            checks: usage.checks + 1,
            messages: usage.messages + (hasVisible ? 1 : 0),
            estimatedTokens: usage.estimatedTokens + Math.max(0, Math.round(estimatedTokens)),
        };
    }
    if (hasVisible && (!rule.lastFiredAt || checkedAtMs > rule.lastFiredAt)) {
        const startsNewDay = !rule.lastFiredAt || localDayKey(rule.lastFiredAt) !== localDayKey(checkedAtMs);
        rule.lastFiredAt = checkedAtMs;
        rule.consecutiveCount = startsNewDay
            ? 1
            : Math.min(IDLE_RECONNECT_MAX_CONSECUTIVE, rule.consecutiveCount + 1);
    }
    saveRules(rules);
}

/** 用户停止了当前这次冷场生成：不计入连发，只推迟下一次尝试。 */
export function suppressIdleReconnectUntil(id: string, untilMs: number): IdleReconnectRule | null {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.id === id);
    if (!rule) return null;
    rule.suppressedUntil = Math.max(rule.suppressedUntil ?? 0, untilMs);
    saveRules(rules);
    return rule;
}

/** 用户在该会话发了消息：连发计数清零。返回被重置的规则（用于重挂预约）。 */
export function resetIdleReconnectForSession(sessionId: string): IdleReconnectRule | null {
    const rules = loadIdleReconnectRules();
    const rule = rules.find(item => item.sessionId === sessionId);
    if (!rule) return null;
    if (rule.consecutiveCount !== 0) {
        rule.consecutiveCount = 0;
    }
    rule.suppressedUntil = undefined;
    saveRules(rules);
    return rule;
}
