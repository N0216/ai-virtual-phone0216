import { personalPushFetch } from "./personal-push-cloud";

export const EXECUTION_TASK_MARKER = "ai_phone_execution_task_v1";
export type ExecutionTaskStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type ExecutionToolTrace = {
  tool: string;
  success: boolean;
  summary?: string;
  error?: string;
  started_at: string;
  finished_at: string;
};
export type ExecutionTask = {
  task_id: string;
  creator: string;
  intent: string;
  permission_scope: string[];
  status: ExecutionTaskStatus;
  result: unknown | null;
  tool_trace: ExecutionToolTrace[];
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export function isExecutionTask(value: unknown): value is ExecutionTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Partial<ExecutionTask>;
  return typeof task.task_id === "string" && typeof task.creator === "string"
    && typeof task.intent === "string" && Array.isArray(task.permission_scope)
    && ["pending", "running", "succeeded", "failed", "cancelled"].includes(String(task.status))
    && typeof task.created_at === "string" && Array.isArray(task.tool_trace);
}

export function executionTaskEnvelope(task: ExecutionTask): Record<string, unknown> {
  return { marker: EXECUTION_TASK_MARKER, ...task };
}

export function executionTaskFromEnvelope(value: unknown): ExecutionTask | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.marker !== EXECUTION_TASK_MARKER || !isExecutionTask(record)) return null;
  return record;
}

async function readTaskResponse(response: Response): Promise<ExecutionTask[]> {
  const data = await response.json().catch(() => null) as { ok?: boolean; tasks?: unknown[]; task?: unknown; error?: string } | null;
  if (!response.ok || !data?.ok) throw new Error(data?.error || `任务交接返回 HTTP ${response.status}`);
  const values = Array.isArray(data.tasks) ? data.tasks : data.task ? [data.task] : [];
  return values.filter(isExecutionTask);
}

export async function listExecutionTasks(status: ExecutionTaskStatus = "pending"): Promise<ExecutionTask[]> {
  return readTaskResponse(await personalPushFetch("execution-task-list", { method: "GET" }, { status }));
}

export async function getExecutionTask(taskId: string): Promise<ExecutionTask> {
  const tasks = await readTaskResponse(await personalPushFetch("execution-task-read", { method: "GET" }, { taskId }));
  if (!tasks[0]) throw new Error("任务不存在。");
  return tasks[0];
}

export async function claimExecutionTask(taskId: string): Promise<ExecutionTask> {
  const tasks = await readTaskResponse(await personalPushFetch("execution-task-claim", {
    method: "POST", body: JSON.stringify({ taskId }),
  }));
  if (!tasks[0]) throw new Error("任务未能领取，可能已被处理或取消。");
  return tasks[0];
}

export async function finishExecutionTask(
  taskId: string,
  input: { status: "succeeded" | "failed"; result?: unknown; tool_trace: ExecutionToolTrace[]; error?: string },
): Promise<ExecutionTask> {
  const tasks = await readTaskResponse(await personalPushFetch("execution-task-finish", {
    method: "POST", body: JSON.stringify({ taskId, ...input }),
  }));
  if (!tasks[0]) throw new Error("任务结果未能写回。");
  return tasks[0];
}
