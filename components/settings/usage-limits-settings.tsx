"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRing, Bot, Image, MessageCircle, Mic, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { Input, Toggle } from "@/components/ui/form";
import {
    clearModelUsage,
    getModelUsageEntries,
    getTodayModelUsage,
    loadModelUsageLimits,
    localUsageDayKey,
    saveModelUsageLimits,
    summarizeModelUsage,
    type ModelUsageCategory,
    type ModelUsageLimitSettings,
    type ModelUsageSummary,
} from "@/lib/model-usage";

const CATEGORY_ROWS: Array<{
    category: ModelUsageCategory;
    label: string;
    description: string;
    icon: typeof MessageCircle;
    color: string;
}> = [
    { category: "manual_chat", label: "手动聊天", description: "你发消息后产生的主模型请求", icon: MessageCircle, color: "#EC4899" },
    { category: "tool", label: "工具结果整理", description: "长工具结果交给指定模型压缩", icon: Wrench, color: "#8B5CF6" },
    { category: "auto_wake", label: "自动醒来", description: "追问、定时唤醒、冷场联系等后台请求", icon: BellRing, color: "#F59E0B" },
    { category: "image", label: "图片生成", description: "成功发起并返回的生图请求", icon: Image, color: "#0EA5E9" },
    { category: "audio", label: "语音", description: "语音合成和语音转文字请求", icon: Mic, color: "#10B981" },
    { category: "background", label: "其他后台模型", description: "记忆整理、应用生成等非聊天请求", icon: Bot, color: "#64748B" },
];

function formatNumber(value: number): string {
    return Math.max(0, Math.round(value)).toLocaleString("zh-CN");
}

function usageText(summary: ModelUsageSummary): string {
    const estimate = summary.hasEstimate ? "约 " : "";
    return `${summary.calls} 次 · ${estimate}${formatNumber(summary.totalTokens)} Token`;
}

function clampInteger(value: string, fallback: number, min: number, max: number): number {
    const parsed = Math.round(Number(value));
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function UsageLimitsSettings() {
    const [limits, setLimits] = useState<ModelUsageLimitSettings>(() => loadModelUsageLimits());
    const [callsDraft, setCallsDraft] = useState(String(limits.autoWakeDailyCalls));
    const [tokensDraft, setTokensDraft] = useState(String(limits.autoWakeDailyTokens));
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        const refresh = () => setRefreshKey(value => value + 1);
        window.addEventListener("model-usage-updated", refresh);
        return () => window.removeEventListener("model-usage-updated", refresh);
    }, []);

    const categoryUsage = useMemo(() => {
        const map = new Map<ModelUsageCategory, ModelUsageSummary>();
        for (const row of CATEGORY_ROWS) map.set(row.category, getTodayModelUsage(row.category));
        return map;
    }, [refreshKey]);

    const todayTotal = useMemo(() => getTodayModelUsage(), [refreshKey]);
    const autoWakeUsage = categoryUsage.get("auto_wake") || getTodayModelUsage("auto_wake");
    const callsPercent = Math.min(100, Math.round(autoWakeUsage.calls / Math.max(1, limits.autoWakeDailyCalls) * 100));
    const tokensPercent = Math.min(100, Math.round(autoWakeUsage.totalTokens / Math.max(1, limits.autoWakeDailyTokens) * 100));

    const recentDays = useMemo(() => {
        const entries = getModelUsageEntries();
        const rows = Array.from({ length: 7 }, (_, index) => {
            const at = new Date();
            at.setDate(at.getDate() - index);
            const dayKey = localUsageDayKey(at.getTime());
            return { dayKey, summary: summarizeModelUsage(entries.filter(entry => entry.dayKey === dayKey)) };
        });
        return rows;
    }, [refreshKey]);

    const persistLimits = useCallback((next: ModelUsageLimitSettings) => {
        setLimits(next);
        saveModelUsageLimits(next);
    }, []);

    const commitCalls = () => {
        const value = clampInteger(callsDraft, limits.autoWakeDailyCalls, 1, 200);
        setCallsDraft(String(value));
        persistLimits({ ...limits, autoWakeDailyCalls: value });
    };

    const commitTokens = () => {
        const value = clampInteger(tokensDraft, limits.autoWakeDailyTokens, 1_000, 5_000_000);
        setTokensDraft(String(value));
        persistLimits({ ...limits, autoWakeDailyTokens: value });
    };

    return (
        <div className="flex flex-col gap-5 pb-8">
            <div className="menu-group p-4 flex flex-col gap-3">
                <div className="flex items-center gap-3">
                    <span className="card-icon" style={{ "--icon-color": "#10B981" } as React.CSSProperties}>
                        <ShieldCheck size={22} strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="menu-label appearance-menu-item-label">自动醒来费用保险</div>
                        <div className="menu-desc">任一上限达到后，暂停后台自动醒来；正常聊天不受影响。</div>
                    </div>
                    <Toggle
                        checked={limits.autoWakeLimitEnabled}
                        onChange={(autoWakeLimitEnabled) => persistLimits({ ...limits, autoWakeLimitEnabled })}
                        className="settings-toggle-control"
                    />
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <label className="flex flex-col gap-1">
                        <span className="menu-desc">每日最多调用</span>
                        <Input
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={200}
                            value={callsDraft}
                            onChange={event => setCallsDraft(event.target.value)}
                            onBlur={commitCalls}
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="menu-desc">每日最多 Token</span>
                        <Input
                            type="number"
                            inputMode="numeric"
                            min={1000}
                            max={5000000}
                            step={1000}
                            value={tokensDraft}
                            onChange={event => setTokensDraft(event.target.value)}
                            onBlur={commitTokens}
                        />
                    </label>
                </div>

                <div className="rounded-2xl bg-black/[0.035] px-3 py-3 flex flex-col gap-2">
                    <div className="flex justify-between gap-3 text-sm">
                        <span>今日后台调用</span>
                        <span>{autoWakeUsage.calls}/{limits.autoWakeDailyCalls}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-black/10">
                        <div className="h-full rounded-full bg-amber-400" style={{ width: `${callsPercent}%` }} />
                    </div>
                    <div className="flex justify-between gap-3 text-sm">
                        <span>今日后台 Token</span>
                        <span>{formatNumber(autoWakeUsage.totalTokens)}/{formatNumber(limits.autoWakeDailyTokens)}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-black/10">
                        <div className="h-full rounded-full bg-amber-400" style={{ width: `${tokensPercent}%` }} />
                    </div>
                </div>
                <p className="menu-desc m-0">默认上限为每日 20 次、100,000 Token。若接口不返回用量，会按文本长度估算并标注“约”。</p>
            </div>

            <section className="flex flex-col gap-2">
                <div className="px-1 flex items-end justify-between gap-3">
                    <div>
                        <h3 className="m-0 text-lg font-semibold">今日用量</h3>
                        <p className="menu-desc m-0">合计 {usageText(todayTotal)}</p>
                    </div>
                </div>
                <div className="menu-group">
                    {CATEGORY_ROWS.map(({ category, label, description, icon: Icon, color }) => {
                        const summary = categoryUsage.get(category) || { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, hasEstimate: false };
                        return (
                            <div className="menu-item" key={category}>
                                <span className="card-icon" style={{ "--icon-color": color } as React.CSSProperties}>
                                    <Icon size={21} strokeWidth={1.75} />
                                </span>
                                <span className="settings-tools-menu-copy">
                                    <span className="menu-label appearance-menu-item-label">{label}</span>
                                    <span className="menu-desc settings-tools-menu-desc">{description}</span>
                                </span>
                                <span className="menu-right text-right whitespace-nowrap">
                                    <span className="text-sm">{usageText(summary)}</span>
                                </span>
                            </div>
                        );
                    })}
                </div>
            </section>

            <section className="flex flex-col gap-2">
                <h3 className="m-0 px-1 text-lg font-semibold">最近 7 天</h3>
                <div className="menu-group">
                    {recentDays.map(({ dayKey, summary }, index) => (
                        <div className="menu-item" key={dayKey}>
                            <span className="settings-tools-menu-copy">
                                <span className="menu-label appearance-menu-item-label">{index === 0 ? "今天" : dayKey}</span>
                            </span>
                            <span className="menu-right text-sm">{usageText(summary)}</span>
                        </div>
                    ))}
                </div>
            </section>

            <button
                type="button"
                className="ui-btn ui-btn-outline flex items-center justify-center gap-2"
                onClick={() => {
                    if (!window.confirm("清空本机保存的用量统计？限额设置不会被删除。")) return;
                    clearModelUsage();
                }}
            >
                <Trash2 size={17} />
                清空用量统计
            </button>

            <p className="menu-desc m-0 px-1">这里是小手机本机记录，方便控制后台消耗；最终账单仍以各 API 服务商后台为准。</p>
        </div>
    );
}
