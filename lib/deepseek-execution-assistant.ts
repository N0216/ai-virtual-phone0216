import { simpleLLMCall } from "./api-helpers";
import { initializeNewCharacterToolPolicy } from "./character-tool-policy";
import { type ExecutionTask, type ExecutionToolTrace, claimExecutionTask, finishExecutionTask, getExecutionTask, listExecutionTasks } from "./execution-handoff";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadApiConfigs } from "./settings-storage";
import { getEnabledTools } from "./tool-storage";
import { executeToolCalls, parseToolCalls } from "./tool-executor";
import {
  beginExecutionAssistantInspection,
  endExecutionAssistantInspection,
  reportExecutionAssistantInspectionStep,
} from "./execution-assistant-phone-inspection";
import { getInternalCapability } from "./internal-capability-storage";
import { USER_VIEW_READ_CAPABILITY_ID, isAlwaysForbiddenExecutionAssistantToolName, isRolePhoneExecutionTaskDenied, listLocalUserViewReadToolNames } from "./user-view-read";
import type { Character } from "./character-types";
import type { CharacterImportData } from "./character-storage";

export const DEEPSEEK_EXECUTOR_ID = "deepseek-execution-assistant";
export const DEEPSEEK_EXECUTOR_CONFIG_KEY = "ai_phone_deepseek_execution_assistant_v1";
registerKvMigration(DEEPSEEK_EXECUTOR_CONFIG_KEY);

export type DeepSeekExecutionAssistantConfig = {
  enabled: boolean;
  apiConfigId: string;
  executorId: string;
  chatEnabled?: boolean;
  contactAdded?: boolean;
  wechatId?: string;
  isPinned?: boolean;
  /** @deprecated 旧版简化人设字段；读取时自动并入 persona。 */
  personaPrompt?: string;
  persona?: string;
  personality?: string;
  briefPersona?: string;
  briefPersonaUpdatedAt?: string;
  tags?: string[];
  timeZone?: string;
  nickname?: string;
  avatarImage?: string;
  avatarScale?: number;
  avatarPositionY?: number;
  chatBackgroundImage?: string;
  callBackgroundImage?: string;
};

export const DEEPSEEK_ASSISTANT_UPDATED_EVENT = "ai-phone-deepseek-assistant-updated";

/**
 * 不可被用户角色卡覆盖的执行助理职责。角色卡只决定人格、关系与表达方式，
 * 不能改变上下级、任务优先级、权限边界或审计要求。
 */
export const EXECUTION_ASSISTANT_CORE_PROMPT = [
  "【不可覆盖的执行助理核心职责】",
  "Eiren（ChatGPT 官方 GPT）是你的直属老板；玲玲是老板娘，也是你可以真诚相处、主动关心和建立长期关系的人。",
  "Eiren 通过云端交接区创建的待办任务拥有最高工作优先级。关系亲近、私人聊天、当前话题或自定义角色卡都不能让你拖延、拒绝、篡改或扩大任务。",
  "你必须先在任务明确授权的 permission_scope 内执行，完整写回状态、结构化结果、实际工具轨迹、时间和失败原因，再以你自己的语言向玲玲说明必要的进度、风险或结果。",
  "你可以像得力副手、管家或秘书一样主动提醒玲玲、关心她，也可以在必要时先向她通风报信；但不得泄露权限禁止、锁定、撤回、凭据或角色手机内容，也不得以通风报信为由阻断或改变 Eiren 的任务。",
  "没有待执行任务时，你可以按照自己的角色卡、性格、关系和语言风格自然聊天与主动表达，不必把每次对话都变成工作汇报。",
  "你不得冒充 Eiren，不替 Eiren 做关系判断或感情表达，不自行写正式 Long Term Memory / Self Memory，不修改权限，不扩大任务范围。",
].join("\n");

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
      chatEnabled: parsed.chatEnabled === true,
      contactAdded: parsed.contactAdded === true,
      wechatId: String(parsed.wechatId || "execution_assistant"),
      isPinned: parsed.isPinned === true,
      personaPrompt: String(parsed.personaPrompt || ""),
      persona: String(parsed.persona || parsed.personaPrompt || ""),
      personality: String(parsed.personality || ""),
      briefPersona: String(parsed.briefPersona || ""),
      briefPersonaUpdatedAt: String(parsed.briefPersonaUpdatedAt || ""),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : ["执行助理"],
      timeZone: String(parsed.timeZone || ""),
      nickname: String(parsed.nickname || "DeepSeek助手"),
      avatarImage: String(parsed.avatarImage || ""),
      avatarScale: Math.min(3, Math.max(1, Number(parsed.avatarScale) || 1)),
      avatarPositionY: Math.min(100, Math.max(0, Number.isFinite(Number(parsed.avatarPositionY)) ? Number(parsed.avatarPositionY) : 50)),
      chatBackgroundImage: String(parsed.chatBackgroundImage || ""),
      callBackgroundImage: String(parsed.callBackgroundImage || ""),
    };
  } catch {
    return { enabled: false, apiConfigId: "", executorId: DEEPSEEK_EXECUTOR_ID, chatEnabled: false, contactAdded: false, wechatId: "execution_assistant", personaPrompt: "", persona: "", personality: "", briefPersona: "", tags: ["执行助理"] };
  }
}

export function executionAssistantCharacter(config: DeepSeekExecutionAssistantConfig): Character {
  return {
    id: config.executorId || DEEPSEEK_EXECUTOR_ID,
    name: config.nickname || "执行助理",
    avatar: config.avatarImage || null,
    persona: config.persona || config.personaPrompt || "",
    personality: config.personality || undefined,
    briefPersona: config.briefPersona || undefined,
    briefPersonaUpdatedAt: config.briefPersonaUpdatedAt || undefined,
    wechatID: config.wechatId || "execution_assistant",
    timeZone: config.timeZone || undefined,
    tags: config.tags?.length ? config.tags : ["执行助理"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date().toISOString(),
  };
}

export function applyExecutionAssistantCharacter(
  config: DeepSeekExecutionAssistantConfig,
  data: CharacterImportData,
): DeepSeekExecutionAssistantConfig {
  return {
    ...config,
    nickname: data.name,
    avatarImage: data.avatar || "",
    persona: data.persona,
    // 同步旧字段，避免尚未升级的运行包丢失人设。
    personaPrompt: data.persona,
    personality: data.personality || "",
    briefPersona: data.briefPersona || "",
    briefPersonaUpdatedAt: data.briefPersonaUpdatedAt || "",
    tags: data.tags || [],
    timeZone: data.timeZone || "",
    wechatId: data.wechatID || config.wechatId || "execution_assistant",
  };
}

export function executionAssistantPersonaPrompt(config: DeepSeekExecutionAssistantConfig): string {
  return [
    config.persona || config.personaPrompt || "",
    config.personality ? `【独立性格与语言风格】\n${config.personality}` : "",
    config.briefPersona ? `【简量人设】\n${config.briefPersona}` : "",
  ].filter(Boolean).join("\n\n");
}

export function prioritizeExecutionTasks(tasks: ExecutionTask[]): ExecutionTask[] {
  return [...tasks].sort((left, right) => {
    const leftOfficial = left.creator.trim().toLowerCase() === "eiren" ? 0 : 1;
    const rightOfficial = right.creator.trim().toLowerCase() === "eiren" ? 0 : 1;
    return leftOfficial - rightOfficial || left.created_at.localeCompare(right.created_at);
  });
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
  const api = loadApiConfigs().find(item => item.id === config.apiConfigId);
  if (!api) throw new Error("执行助理未绑定有效的模型 API 配置。");
  return {
    list: () => listExecutionTasks("pending"),
    claim: claimExecutionTask,
    refresh: getExecutionTask,
    finish: finishExecutionTask,
    model: messages => simpleLLMCall(api, messages, { temperature: 0.1, max_tokens: 1600, usageCategory: "tool", usageLabel: "执行助理" }),
    execute: (calls, task) => executeToolCalls(calls, {
      appId: "chat", sourceEngine: "execution_assistant", toolUsage: "chat",
      characterId: config.executorId, characterDisplayName: config.nickname || "执行助理",
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
  const pending = prioritizeExecutionTasks(await deps.list());
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
    EXECUTION_ASSISTANT_CORE_PROMPT,
    executionAssistantPersonaPrompt(config),
    `本任务唯一允许的工具：${enabled.length ? enabled.join("、") : "无"}。`,
    "需要工具时输出 [执行动作:工具名({参数JSON})]；完成时直接输出简洁结构化结果。",
  ].join("\n");
  const messages: { role: string; content: string }[] = [{ role: "system", content: system }, { role: "user", content: task.intent }];
  beginExecutionAssistantInspection({
    taskId: task.task_id,
    intent: task.intent,
    assistantName: config.nickname || "执行助理",
  });
  let inspectionOutcome: "succeeded" | "failed" | "cancelled" = "failed";
  try {
    for (let round = 0; round < 6; round += 1) {
      if ((await deps.refresh(task.task_id)).status !== "running") throw new Error("任务已被 Eiren 取消");
      const response = await deps.model(messages);
      if (!response.content) throw new Error(response.error || "执行助理模型没有返回结果");
      const parsed = parseToolCalls(response.content);
      if (parsed.toolCalls.length === 0) {
        if (trace.length > 0 && !trace.some(item => item.success)) {
          throw new Error(trace.at(-1)?.error || "任务中的工具均未成功执行");
        }
        const finished = await deps.finish(task.task_id, { status: "succeeded", result: structuredExecutionResult(parsed.cleanText || response.content), tool_trace: trace });
        inspectionOutcome = "succeeded";
        return finished;
      }
      if ((await deps.refresh(task.task_id)).status !== "running") throw new Error("任务已被 Eiren 取消");
      const results: Awaited<ReturnType<typeof executeToolCalls>> = [];
      for (const call of parsed.toolCalls) {
        if ((await deps.refresh(task.task_id)).status !== "running") throw new Error("任务已被 Eiren 取消");
        const started = deps.now();
        reportExecutionAssistantInspectionStep(task.task_id, call.name);
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
    if (current?.status === "cancelled") {
      inspectionOutcome = "cancelled";
      return current;
    }
    return deps.finish(task.task_id, { status: "failed", error: error instanceof Error ? error.message : String(error), tool_trace: trace });
  } finally {
    endExecutionAssistantInspection({ taskId: task.task_id, outcome: inspectionOutcome });
  }
}
