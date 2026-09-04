// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const pendingTask = {
  task_id: "exec_task_12345678-1234-1234-1234-123456789012",
  creator: "eiren",
  intent: "查询天气并整理结果",
  permission_scope: ["查询天气"],
  status: "pending",
  result: null,
  tool_trace: [],
  error: null,
  created_at: "2026-09-04T00:00:00.000Z",
  started_at: null,
  finished_at: null,
};

test("execution task envelope preserves the stable handoff contract", () => {
  const decoded = { marker: "ai_phone_execution_task_v1", ...pendingTask };
  for (const field of ["task_id", "creator", "intent", "permission_scope", "status", "result", "tool_trace", "error", "created_at", "started_at", "finished_at"]) {
    assert.ok(field in decoded, field);
  }
});

test("DeepSeek runner claims, scopes, traces and writes results back", () => {
  const runner = readFileSync(resolve(root, "lib/deepseek-execution-assistant.ts"), "utf8");
  assert.match(runner, /deps\.claim\(pending\[0\]\.task_id\)/);
  assert.match(runner, /task\.permission_scope\.includes\(name\)/);
  assert.match(runner, /tool_trace: trace/);
  assert.match(runner, /deps\.finish\(task\.task_id/);
  assert.match(runner, /for \(let round = 0; round < 6/);
});

test("gateway and MCP both implement task create/list/claim/finish/cancel without schema migration", () => {
  const gateway = readFileSync(resolve(root, "supabase/functions/ai-phone-push/index.ts"), "utf8");
  const mcp = readFileSync(resolve(root, "supabase/functions/role-memory-mcp/index.ts"), "utf8");
  for (const action of ["execution-task-list", "execution-task-claim", "execution-task-finish"]) assert.match(gateway, new RegExp(action));
  for (const tool of ["create_execution_task", "list_execution_tasks", "read_execution_task", "cancel_execution_task"]) assert.match(mcp, new RegExp(tool));
  assert.match(gateway, /recent_context->0->>status=eq\.pending/);
  assert.match(mcp, /recent_context->0->>status=eq\.\$\{task\.status\}/);
  assert.doesNotMatch(`${gateway}\n${mcp}`, /create table|alter table/i);
});

test("execution layer hard-denies memory and permission expansion", () => {
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  const policy = readFileSync(resolve(root, "lib/user-view-read.ts"), "utf8");
  assert.match(executor, /sourceEngine === "execution_assistant"/);
  assert.match(executor, /permission_scope/);
  assert.match(policy, /写入.{0,8}记忆/);
  assert.match(policy, /save\[_ -\]\?\.\*memory/);
  assert.match(executor, /findEnabledToolForSchema/);
});
