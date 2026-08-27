"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { Toggle } from "@/components/ui/form";
import {
    ensureCharacterToolPolicy,
    isToolAllowedForCharacter,
    loadCharacterToolPolicy,
    saveCharacterToolPermission,
    type CharacterToolPolicy,
} from "@/lib/character-tool-policy";
import {
    compositeToolPermissionKey,
    customAppToolPermissionKey,
    enabledToolKey,
    getEnabledTools,
    internalSubToolPermissionKey,
    mcpToolPermissionKey,
    restToolPermissionKey,
    type EnabledTool,
} from "@/lib/tool-storage";
import { loadApiConfigs } from "@/lib/settings-storage";

type ToolLeaf = {
    key: string;
    name: string;
    description: string;
};

type ToolGroup = {
    key: string;
    name: string;
    description: string;
    leaves: ToolLeaf[];
};

function toolGroups(): ToolGroup[] {
    return getEnabledTools("chat").map((tool: EnabledTool) => {
        let leaves: ToolLeaf[] = [];
        if (tool.source === "rest_package") {
            leaves = (tool.restTools || []).map(item => ({ key: restToolPermissionKey(item.id), name: item.name, description: item.description || "REST 工具" }));
        } else if (tool.source === "composite_package") {
            leaves = (tool.compositeTools || []).map(item => ({ key: compositeToolPermissionKey(item.id), name: item.name, description: item.description || "组合工具" }));
        } else if (tool.source === "mcp_server") {
            leaves = (tool.mcpTools || []).map(item => ({ key: mcpToolPermissionKey(tool.sourceId, item.name), name: item.name, description: item.description || "MCP 工具" }));
        } else if (tool.source === "custom_app_package") {
            leaves = (tool.customAppTools || []).map(item => ({ key: customAppToolPermissionKey(item.appId, item.id), name: item.name, description: item.description || `来自「${item.appName}」` }));
        } else if (tool.source === "internal" && tool.internalTools?.length) {
            leaves = tool.internalTools.map(item => ({
                key: internalSubToolPermissionKey(tool.sourceId, item.name),
                name: item.name,
                description: item.description,
            }));
        } else {
            leaves = [{ key: enabledToolKey(tool), name: tool.name, description: tool.description }];
        }
        return {
            key: `${tool.source}:${tool.sourceId}`,
            name: tool.name,
            description: tool.description,
            leaves,
        };
    }).filter(group => group.leaves.length > 0);
}

export function getRoleToolChatEnabledCount(characterId: string): number {
    const policy = loadCharacterToolPolicy(characterId);
    const groups = toolGroups();
    if (!policy?.initialized) return groups.reduce((sum, group) => sum + group.leaves.length, 0);
    return groups.reduce((sum, group) => sum + group.leaves.filter(leaf => isToolAllowedForCharacter(characterId, leaf.key, "chat")).length, 0);
}

export function CharacterToolsPage({
    characterId,
    characterName,
    onClose,
    onCountChange,
}: {
    characterId: string;
    characterName: string;
    onClose: () => void;
    onCountChange?: (count: number) => void;
}) {
    const groups = useMemo(() => toolGroups(), []);
    const allKeys = useMemo(() => groups.flatMap(group => group.leaves.map(leaf => leaf.key)), [groups]);
    const [policy, setPolicy] = useState<CharacterToolPolicy>(() => ensureCharacterToolPolicy(characterId, allKeys));
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const apiConfigs = useMemo(() => loadApiConfigs(), []);

    const update = (key: string, patch: Parameters<typeof saveCharacterToolPermission>[2]) => {
        const next = saveCharacterToolPermission(characterId, key, patch);
        setPolicy({ ...next, permissions: { ...next.permissions } });
        onCountChange?.(allKeys.filter(item => next.permissions[item]?.chatEnabled).length);
    };

    const updateGroupChat = (group: ToolGroup, enabled: boolean) => {
        let next = policy;
        for (const leaf of group.leaves) next = saveCharacterToolPermission(characterId, leaf.key, { chatEnabled: enabled });
        setPolicy({ ...next, permissions: { ...next.permissions } });
        onCountChange?.(allKeys.filter(item => next.permissions[item]?.chatEnabled).length);
    };

    return (
        <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "var(--c-page-body-bg)" }}>
            <PageShell title="角色工具" onBack={onClose}>
                <div className="px-4 pt-3 pb-8">
                    <div className="rounded-2xl bg-[var(--c-card)] px-4 py-3 mb-4">
                        <div className="font-semibold text-[var(--c-text)]">{characterName}</div>
                        <div className="menu-desc mt-1">只影响这个角色；同一角色的所有聊天共用。新安装的工具默认关闭。</div>
                    </div>

                    {groups.length === 0 && (
                        <div className="ui-empty">当前没有已安装并启用的工具</div>
                    )}

                    <div className="flex flex-col gap-3">
                        {groups.map(group => {
                            const isExpanded = expanded[group.key] === true;
                            const enabledCount = group.leaves.filter(leaf => policy.permissions[leaf.key]?.chatEnabled).length;
                            const allEnabled = enabledCount === group.leaves.length;
                            return (
                                <div key={group.key} className="rounded-2xl overflow-hidden bg-[var(--c-card)]">
                                    <div className="flex items-center gap-3 px-4 py-3">
                                        <button
                                            type="button"
                                            className="min-w-0 flex-1 flex items-center gap-3 text-left"
                                            onClick={() => setExpanded(value => ({ ...value, [group.key]: !isExpanded }))}
                                        >
                                            <span className="w-9 h-9 rounded-full grid place-items-center bg-[var(--c-input)] text-[var(--c-icon)]"><Wrench size={18} /></span>
                                            <span className="min-w-0 flex-1">
                                                <span className="block font-medium text-[var(--c-text)] truncate">{group.name}</span>
                                                <span className="menu-desc block truncate">已开启 {enabledCount}/{group.leaves.length}</span>
                                            </span>
                                            {isExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
                                        </button>
                                        <Toggle checked={allEnabled} onChange={value => updateGroupChat(group, value)} />
                                    </div>

                                    {isExpanded && (
                                        <div className="border-t border-[var(--c-border)]">
                                            {group.leaves.map(leaf => {
                                                const permission = policy.permissions[leaf.key] || { chatEnabled: false, autoWakeEnabled: false };
                                                return (
                                                    <div key={leaf.key} className="px-4 py-4 border-b last:border-b-0 border-[var(--c-border)]">
                                                        <div className="font-medium text-[var(--c-text)] break-all">{leaf.name}</div>
                                                        <div className="menu-desc mt-1 mb-3">{leaf.description}</div>
                                                        <div className="flex items-center justify-between py-1">
                                                            <span className="text-sm text-[var(--c-text)]">普通聊天可用</span>
                                                            <Toggle checked={permission.chatEnabled} onChange={value => update(leaf.key, { chatEnabled: value })} />
                                                        </div>
                                                        <div className="flex items-center justify-between py-1">
                                                            <span className="text-sm text-[var(--c-text)]">自动醒来可用</span>
                                                            <Toggle checked={permission.autoWakeEnabled} onChange={value => update(leaf.key, { autoWakeEnabled: value })} />
                                                        </div>
                                                        <label className="block mt-3">
                                                            <span className="menu-desc block mb-1">工具结果整理模型（长结果先由它压缩，主模型少读内容）</span>
                                                            <select
                                                                className="ui-input w-full"
                                                                value={permission.apiConfigId || ""}
                                                                onChange={event => update(leaf.key, { apiConfigId: event.target.value || undefined })}
                                                            >
                                                                <option value="">默认（跟随当前聊天模型）</option>
                                                                {apiConfigs.map(config => (
                                                                    <option key={config.id} value={config.id}>{config.name || config.provider} · {config.defaultModel}</option>
                                                                ))}
                                                            </select>
                                                        </label>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </PageShell>
        </div>
    );
}
