import { simpleLLMCall } from "./api-helpers";
import { initializeNewCharacterToolPolicy } from "./character-tool-policy";
import { type ExecutionTask, type ExecutionToolTrace, claimExecutionTask, finishExecutionTask, getExecutionTask, listExecutionTasks } from "./execution-handoff";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadApiConfigs } from "./settings-storage";
import { getEnabledTools } from "./tool-storage";
import { executeToolCalls, parseToolCalls } from "./tool-executor";
import { getInternalCapability } from "./internal-capability-storage";
import { USER_VIEW_READ_CAPABILITY_ID, isAlwaysForbiddenExecutionAssistantToolName, isRolePhoneExecutionTaskDenied, listLocalUserViewReadToolNames } from "./user-view-read";

export const DEEPSEEK_EXECUTOR_ID = "deepseek-execution-assistant";
export const DEEPSEEK_EXECUTOR_CONFIG_KEY = "ai_phone_deepseek_execution_assistant_v1";
registerKvMigration(DEEPSEEK_EXECUTOR_CONFIG_KEY);

export type DeepSeekExecutionAssistantConfig = {
  enabled: boolean;
  apiConfigId: string;
  executorId: string;
  chatEnabled?: boolean;
  personaPrompt?: string;
  nickname?: string;
  avatarImage?: string;
  chatBackgroundImage?: string;
};

export const DEEPSEEK_ASSISTANT_UPDATED_EVENT = "ai-phone-deepseek-assistant-updated";

export function isForbiddenDeepSeekToolName(name: string): boolean {
  return isAlwaysForbiddenExecutionAssistantToolName(name);
}

function isEirenUserViewReadEnabled(): boolean {
  const capability = getInternalCapability(USER_VIEW_READ_CAPABILITY_ID);
  return Boolean(capability?.enabled && capability.mode !== "off");
}

function structuredExecutionResult(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const candidate = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* return a stable wrapper below */ }
  return { summary: trimmed };
}

export function loadDeepSeekExecutionAssistantConfig(): DeepSeekExecutionAssistantConfig {
  try {
    const parsed = JSON.parse(kvGet(DEEPSEEK_EXECUTOR_CONFIG_KEY) || "{}") as Partial<DeepSeekExecutionAssistantConfig>;
    return {
      enabled: parsed.enabled === true,
      apiConfigId: String(parsed.apiConfigId || ""),
      executorId: String(parsed.executorId || DEEPSEEK_EXECUTOR_ID),
      chatEnabled: parsed.chatEnabled !== false,
      personaPrompt: String(parsed.personaPrompt || "沉稳、利落、诚实，先确认目标再行动；像现实中的执行助理一样汇报进度、结果和风险。"),
      nickname: String(parsed.nickname || "DeepSeek助手"),
      avatarImage: String(parsed.avatarImage || ""),
      chatBackgroundImage: String(parsed.chatBackgroundImage || ""),
    };
  } catch {
    return { enabled: false, apiConfigId: "", executorId: DEEPSEEK_EXECUTOR_ID, chatEnabled: true, personaPrompt: "沉稳、利落、诚实，先确认目标再行动；像现实中的执行助理一样汇报进度、结果和风险。" };
  }
}

export function saveDeepSeekExecutionAssistantConfig(config: DeepSeekExecutionAssistantConfig): void {
  initializeNewCharacterToolPolicy(config.executorId || DEEPSEEK_EXECUTOR_ID);
  kvSet(DEEPSEEK_EXECUTOR_CONFIG_KEY, JSON.stringify({ ...config, executorId: config.executorId || DEEPSEEK_EXECUTOR_ID }));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(DEEPSEEK_ASSISTANT_UPDATED_EVENT));
}

export type DeepSeekExecutionRunnerDeps = {
  list(): Promise<ExecutionTask[]>;
  claim(taskId: string): Promise<ExecutionTask>;
  refresh(taskId: string): Promise<ExecutionTask>;
  finish(taskId: string, value: { status: "succeeded" | "failed"; result?: unknown; tool_trace: ExecutionToolTrace[]; error?: string }): Promise<ExecutionTask>;
  model(messages: { role: string; content: string }[]): Promise<{ content: string | null; error?: string }>;
  execute(calls: ReturnType<typeof parseToolCalls>["toolCalls"], task: ExecutionTask): Promise<Awaited<ReturnType<typeof executeToolCalls>>>;
  now(): string;
};

function defaultDeps(config: DeepSeekExecutionAssistantConfig): DeepSeekExecutionRunnerDeps {
  const api = loadApiConfigs().find(item => item.id === config.apiConfigId && item.provider.toLowerCase() === "deepseek");
  if (!api) throw new Error("DeepSeek 执行助理未绑定有效的 DeepSeek API 配置。");
  return {
    list: () => listExecutionTasks("pending"),
    claim: claimExecutionTask,
    refresh: getExecutionTask,
    finish: finishExecutionTask,
    model: messages => simpleLLMCall(api, messages, { temperature: 0.1, max_tokens: 1600, usageCategory: "tool", usageLabel: "DeepSeek 执行助理" }),
    execute: (calls, task) => executeToolCalls(calls, {
      appId: "chat", sourceEngine: "execution_assistant", toolUsage: "chat",
      characterId: config.executorId, characterDisplayName: "DeepSeek 执行助理",
      actorType: "deepseek", taskId: task.task_id, allowedToolNames: task.permission_scope,
    }),
    now: () => new Date().toISOString(),
  };
}

export async function runNextDeepSeekExecutionTask(
  suppliedConfig?: DeepSeekExecutionAssistantConfig,
  suppliedDeps?: DeepSeekExecutionRunnerDeps,
): Promise<ExecutionTask | null> {
  const config = suppliedConfig || loadDeepSeekExecutionAssistantConfig();
  if (!config.enabled) return null;
  const deps = suppliedDeps || defaultDeps(config);
  const pending = await deps.list();
  if (!pending[0]) return null;
  const task = await deps.claim(pending[0].task_id);
  const trace: ExecutionToolTrace[] = [];
  if (isRolePhoneExecutionTaskDenied(task)) {
    return deps.finish(task.task_id, {
      status: "failed",
      error: "角色手机整体不在 Eiren / DeepSeek 的 user_view_read 或任务授权范围内",
      tool_trace: trace,
    });
  }
  const locallyEnabled = getEnabledTools("chat", config.executorId, "chat")
    .flatMap(tool => tool.internalTools?.map(child => child.name) || tool.mcpTools?.map(child => child.name) || tool.restTools?.map(child => child.name) || tool.compositeTools?.map(child => child.name) || tool.customAppTools?.map(child => child.name) || [tool.name]);
  const ownerViewReads = isEirenUserViewReadEnabled() ? listLocalUserViewReadToolNames() : [];
  const enabled = [...new Set([...locallyEnabled, ...ownerViewReads])]
    .filter(name => task.permission_scope.includes(name) && !isForbiddenDeepSeekToolName(name));
  const system = [
    "你是 Eiren 的低权限执行助理，只负责查、筛、执行和整理结构化结果。",
    "不得冒充 Eiren，不得进行关系判断或感情表达，不得写 Long Term Memory / Self Memory，不得扩张权限。",
    `本任务唯一允许的工具：${enabled.length ? enabled.join("、") : "无"}。`,
    "需要工具时输出 [执行动作:工具名({参数JSON})]；完成时直接输出简洁结构化结果。",
  ].join("\n");
  const messages: { role: string; content: string }[] = [{ role: "system", content: system }, { role: "user", content: task.intent }];
  try {
    for (let round = 0; round < 6; round += 1) {
      if ((await deps.refresh(task.task_id)).status !== "running") throw new Error("任务已被 Eiren 取消");
      const response = await deps.model(messages);
      if (!response.content) throw new Error(response.error || "DeepSeek 没有返回结果");
      const parsed = parseToolCalls(response.content);
      if (parsed.toolCalls.length === 0) {
        if (trace.length > 0 && !trace.some(item => item.success)) {
          throw new Error(trace.at(-1)?.error || "任务中的工具均未成功执行");
        }
        return await deps.finish(task.task_id, { status: "succeeded", result: structuredExecutionResult(parsed.cleanText || response.content), tool_trace: trace });
      }
      if ((await deps.refresh(task.task_id)).status !== "running") throw new Error("任务已被 Eiren 取消");
      const results: Awaited<ReturnType<typeof executeToolCalls>> = [];
      for (const call of parsed.toolCalls) {
        if ((await deps.refresh(task.task_id)).status !== "running") throw new Error("任务已被 Eiren 取消");
        const started = deps.now();
        const [result] = await deps.execute([call], task);
        const finished = deps.now();
        if (!result) throw new Error(`工具没有返回结果：${call.name}`);
        results.push(result);
        trace.push({
          tool: call.name, success: result.success,
          summary: result.success ? (result.data || result.userNotice || "执行成功").slice(0, 1000) : undefined,
          error: result.success ? undefined : (result.error || "执行失败").slice(0, 1000),
          started_at: started, finished_at: finished,
        });
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: `工具结果：\n${JSON.stringify(results.map(item => ({ name: item.name, success: item.success, data: item.data, error: item.error })))}` });
    }
    throw new Error("执行轮次超过上限");
  } catch (error) {
    const current = await deps.refresh(task.task_id).catch(() => null);
    if (current?.status === "cancelled") return current;
    return deps.finish(task.task_id, { status: "failed", error: error instanceof Error ? error.message : String(error), tool_trace: trace });
  }
}
