"use client";

import { useEffect, useMemo, useState } from "react";

import { Toggle, Select } from "@/components/ui/form";
import {
  loadCharacterToolPolicy,
  saveCharacterToolPermission,
} from "@/lib/character-tool-policy";
import {
  DEEPSEEK_EXECUTOR_ID,
  isForbiddenDeepSeekToolName,
  loadDeepSeekExecutionAssistantConfig,
  saveDeepSeekExecutionAssistantConfig,
  type DeepSeekExecutionAssistantConfig,
} from "@/lib/deepseek-execution-assistant";
import { loadApiConfigs } from "@/lib/settings-storage";
import { listToolPermissionEntries } from "@/lib/tool-storage";

export function DeepSeekExecutionSettings() {
  const [config, setConfig] = useState<DeepSeekExecutionAssistantConfig>(() => loadDeepSeekExecutionAssistantConfig());
  const [revision, setRevision] = useState(0);
  const apis = useMemo(() => loadApiConfigs().filter(api => api.provider.toLowerCase() === "deepseek"), []);
  const tools = useMemo(() => listToolPermissionEntries("chat").filter(tool => !isForbiddenDeepSeekToolName(tool.name)), [revision]);
  const policy = loadCharacterToolPolicy(DEEPSEEK_EXECUTOR_ID);

  useEffect(() => {
    if (!config.apiConfigId && apis[0]) {
      const next = { ...config, apiConfigId: apis[0].id, executorId: DEEPSEEK_EXECUTOR_ID };
      setConfig(next);
      saveDeepSeekExecutionAssistantConfig(next);
    }
  }, [apis, config]);

  const saveConfig = (patch: Partial<DeepSeekExecutionAssistantConfig>) => {
    const next = { ...config, ...patch, executorId: DEEPSEEK_EXECUTOR_ID };
    setConfig(next);
    saveDeepSeekExecutionAssistantConfig(next);
    setRevision(value => value + 1);
  };

  const toggleTool = (key: string, enabled: boolean) => {
    saveCharacterToolPermission(DEEPSEEK_EXECUTOR_ID, key, {
      chatEnabled: enabled,
      autoWakeEnabled: false,
      confirmation: "inherit",
    });
    setRevision(value => value + 1);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-between items-center">
        <p className="settings-menu-section-title">Execution Assistant</p>
      </div>
      <div className="ui-group-card flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="menu-label">DeepSeek 执行助理</div>
            <div className="menu-desc !mt-1">只领取官软 Eiren 创建的任务；任务范围与下方本地授权取交集。</div>
          </div>
          <Toggle checked={config.enabled} disabled={!config.apiConfigId} onChange={enabled => saveConfig({ enabled })} />
        </div>
        <Select
          value={config.apiConfigId}
          onChange={event => saveConfig({ apiConfigId: event.target.value })}
          disabled={!apis.length}
        >
          <option value="">{apis.length ? "选择 DeepSeek API" : "请先添加 DeepSeek API"}</option>
          {apis.map(api => <option key={api.id} value={api.id}>{api.name || "DeepSeek"}</option>)}
        </Select>
        <details className="rounded-xl border border-black/10 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold">执行助理工具授权（{tools.filter(tool => policy?.permissions[tool.key]?.chatEnabled).length}/{tools.length}）</summary>
          <div className="mt-3 flex max-h-72 flex-col gap-2 overflow-auto">
            {tools.length === 0 ? <span className="menu-desc">当前没有已全局启用的可授权工具。</span> : tools.map(tool => (
              <div key={tool.key} className="flex items-center justify-between gap-3 rounded-lg bg-black/[0.03] px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{tool.name}</div>
                  <div className="menu-desc !mt-0 truncate">{tool.description || tool.source}</div>
                </div>
                <Toggle checked={policy?.permissions[tool.key]?.chatEnabled === true} onChange={enabled => toggleTool(tool.key, enabled)} />
              </div>
            ))}
          </div>
        </details>
        <div className="menu-desc !mt-0">Eiren 本人视角只读范围无需在这里逐项重复授权，但角色手机整体排除，并仍受每个任务 permission_scope 限制。写入、删除、发送、执行、记忆、权限和工具箱动作继续使用独立授权，不能通过任务提示词绕过。</div>
      </div>
    </div>
  );
}
