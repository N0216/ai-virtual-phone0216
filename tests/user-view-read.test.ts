// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  USER_VIEW_READ_CAPABILITY_ID,
  findUserViewReadRegistration,
  isBroadLocalDataScopeContainingRolePhone,
  isRolePhoneExecutionTaskDenied,
  isRolePhoneLocalDataPath,
  isRolePhoneReference,
  isRolePhoneUserViewReadCallDenied,
  resolveUserViewReadPermission,
  sanitizeUserViewReadResult,
} from "../lib/user-view-read.ts";

const root = resolve(import.meta.dirname, "..");

test("owner-visible read calls are covered by one long-lived Eiren grant", () => {
  for (const name of [
    "查看小手机设置", "查看设备操作日志", "列出可查看的互动", "查看最近聊天", "查看通话内容",
    "列出资料目录", "读取资料文件", "查看资料字段", "搜索资料记录", "读取资料记录",
  ]) {
    const decision = resolveUserViewReadPermission({
      call: { name, args: {} },
      grantEnabled: true,
      taskPermissionScope: [name],
    });
    assert.equal(decision.allowed, true, name);
    assert.ok(decision.registration?.capabilityId, name);
  }
  assert.equal(USER_VIEW_READ_CAPABILITY_ID, "user_view_read");
});

test("ordinary reads need no second per-tool grant, but task scope is mandatory", () => {
  const call = { name: "查看最近聊天", args: { limit: 5 } };
  assert.equal(resolveUserViewReadPermission({ call, grantEnabled: true, taskPermissionScope: [call.name] }).allowed, true);
  assert.deepEqual(
    resolveUserViewReadPermission({ call, grantEnabled: true, taskPermissionScope: ["查看小手机设置"] }).reason,
    "outside_task_scope",
  );
});

test("write, delete, send, command and Reality actions never inherit user_view_read", () => {
  const denied = [
    { name: "修改小手机设置", args: {} },
    { name: "发送文件", args: {} },
    { name: "查看全部手机数据", args: {} },
    { name: "任意快捷指令", args: {} },
    { name: "角色电脑", args: { op: "write" } },
    { name: "角色电脑", args: { op: "delete" } },
    { name: "角色电脑", args: { op: "send" } },
    { name: "角色电脑", args: { op: "exec" } },
  ];
  for (const call of denied) {
    assert.equal(findUserViewReadRegistration(call), null, `${call.name}:${call.args.op || ""}`);
  }
  assert.equal(findUserViewReadRegistration({ name: "角色电脑", args: { op: "read" } })?.capabilityId, "agent_computer");
  assert.equal(findUserViewReadRegistration({ name: "角色电脑", args: { op: "list" } })?.capabilityId, "agent_computer");
});

test("revoking user_view_read invalidates the complete registered read group immediately", () => {
  for (const name of ["查看最近聊天", "查看通话内容", "读取资料文件", "查看设备操作日志"]) {
    const decision = resolveUserViewReadPermission({
      call: { name, args: {} }, grantEnabled: false, taskPermissionScope: [name],
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "grant_revoked");
  }
  const gateway = readFileSync(resolve(root, "supabase/functions/ai-phone-push/index.ts"), "utf8");
  const mcp = readFileSync(resolve(root, "supabase/functions/role-memory-mcp/index.ts"), "utf8");
  assert.match(gateway, /action === "user-view-read-policy"/);
  assert.match(gateway, /resolution=merge-duplicates/);
  assert.match(mcp, /USER_VIEW_READ_TOOLS\.has\(name\) && !userViewReadEnabled/);
  assert.match(mcp, /TOOLS\.filter\(tool => !USER_VIEW_READ_TOOLS\.has\(tool\.name\)\)/);
});

test("DeepSeek cannot enlarge task scope and read aggregation preserves leaf audit identity", () => {
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  const log = readFileSync(resolve(root, "lib/device-operation-log.ts"), "utf8");
  assert.match(executor, /taskPermissionScope: context\.allowedToolNames/);
  assert.match(executor, /该工具不在当前任务的 permission_scope 内/);
  assert.match(executor, /capabilityId: userViewRegistration\?\.capabilityId/);
  assert.match(executor, /authorizationBasis: userViewRegistration \? USER_VIEW_READ_CAPABILITY_ID/);
  assert.match(log, /capabilityId\?: string/);
  assert.match(log, /authorizationBasis\?: "user_view_read"/);
});

test("withdrawn, deleted, blacklisted, locked and credential content retain hard filters", () => {
  const interaction = readFileSync(resolve(root, "lib/phone-interaction-tools.ts"), "utf8");
  const localData = readFileSync(resolve(root, "lib/local-data-fs.ts"), "utf8");
  assert.match(interaction, /message\.isRetracted/);
  assert.match(interaction, /session\.isBlacklisted/);
  assert.match(interaction, /if \(!contact\) return null/);
  assert.match(interaction, /isSessionExplicitlyReadable/);
  assert.match(localData, /isExplicitlyEirenHidden/);
  assert.match(localData, /allowEirenView === false/);
  assert.match(localData, /credential/);
  assert.match(localData, /redactSensitiveLogText\(value\)/);
  assert.match(interaction, /SECRET_FIELD_TEXT/);
  const privateAccess = readFileSync(resolve(root, "lib/private-content-access.ts"), "utf8");
  const mcp = readFileSync(resolve(root, "supabase/functions/role-memory-mcp/index.ts"), "utf8");
  assert.match(privateAccess, /canReadSession: async session => !isExplicitlyDeniedToEiren\(session\)/);
  assert.match(mcp, /rows\.filter\(isRowVisibleToEiren\)/);
  assert.match(mcp, /该通话已锁定或不允许 Eiren 查看/);
});

test("MCP task creation permits registered reads but still rejects write and permission scopes", () => {
  const mcp = readFileSync(resolve(root, "supabase/functions/role-memory-mcp/index.ts"), "utf8");
  const forbiddenLine = mcp.match(/const forbiddenPermission[^\n]+/)?.[0] || "";
  assert.doesNotMatch(forbiddenLine, /查看最近聊天|查看通话内容|列出可查看的互动/);
  assert.match(forbiddenLine, /工具箱/);
  assert.match(forbiddenLine, /权限/);
  assert.match(forbiddenLine, /写入/);
});

test("role phone is a complete deny-domain outside user_view_read", () => {
  for (const path of [
    "/creative/indexeddb/AiPhoneCheckPhoneDB",
    "/creative/kv/ai_phone_checkphone_events_role-1",
    "/cache/localStorage/checkphone-settings",
    "/cache/kv/checkphone:xiaohongshu:readThreads",
  ]) assert.equal(isRolePhoneLocalDataPath(path), true, path);
  for (const path of ["/creative", "/creative/indexeddb", "/creative/kv", "/cache", "/cache/kv", "/cache/localStorage"])
    assert.equal(isBroadLocalDataScopeContainingRolePhone(path), true, path);
  assert.equal(isRolePhoneReference("virtual_phone"), true);
  assert.equal(isRolePhoneReference("普通聊天"), false);
  assert.equal(isRolePhoneUserViewReadCallDenied({ name: "任意 MCP 查询", args: { query: "查手机活动" } }), true);
  assert.equal(isRolePhoneUserViewReadCallDenied({ name: "任意 MCP 查询", args: { query: "普通资料" } }), false);
  assert.equal(resolveUserViewReadPermission({
    call: { name: "读取资料文件", args: { path: "/creative/indexeddb/AiPhoneCheckPhoneDB" } },
    grantEnabled: true,
    taskPermissionScope: ["读取资料文件"],
  }).reason, "role_phone_excluded");
  assert.equal(resolveUserViewReadPermission({
    call: { name: "搜索资料记录", args: { path: "/cache" } },
    grantEnabled: true,
    taskPermissionScope: ["搜索资料记录"],
  }).reason, "role_phone_excluded");

  const sanitized = sanitizeUserViewReadResult({
    entries: [
      { name: "AiPhoneCheckPhoneDB", value: "secret role phone payload" },
      { name: "ordinary-notes", value: "safe" },
    ],
    summary: "角色手机最近活动",
  }) as { entries: Array<{ name: string; value: string }>; summary: string };
  assert.deepEqual(sanitized.entries, [{ name: "ordinary-notes", value: "safe" }]);
  assert.equal(sanitized.summary, "[角色手机数据不可读]");
  assert.equal(isRolePhoneExecutionTaskDenied({ intent: "读取角色手机最近活动", permission_scope: ["读取资料文件"] }), true);
  assert.equal(isRolePhoneExecutionTaskDenied({ intent: "读取普通笔记", permission_scope: ["读取资料文件"] }), false);
});

test("local, cloud, log and DeepSeek paths enforce the role-phone exclusion", () => {
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  const mcp = readFileSync(resolve(root, "supabase/functions/role-memory-mcp/index.ts"), "utf8");
  const gateway = readFileSync(resolve(root, "supabase/functions/ai-phone-push/index.ts"), "utf8");
  const deepseek = readFileSync(resolve(root, "lib/deepseek-execution-assistant.ts"), "utf8");

  assert.match(executor, /isRolePhoneLocalDataPath\(normalizedPath\)/);
  assert.match(executor, /isBroadLocalDataScopeContainingRolePhone\(normalizedPath\)/);
  assert.match(executor, /sanitizeUserViewReadResult\(data\)/);
  assert.match(executor, /context\?\.sourceEngine === "execution_assistant"/);
  assert.match(executor, /isRolePhoneUserViewReadCallDenied\(call\)/);
  assert.match(executor, /filter\(entry => !isRolePhoneReference/);
  assert.match(mcp, /source_type=neq\.virtual_phone/);
  assert.match(mcp, /sourceType !== "virtual_phone"/);
  assert.match(mcp, /if \(sourceType === "virtual_phone" \|\| isRolePhoneRelated\(query\)\)/);
  assert.match(mcp, /if \(isRolePhoneRelated\(task\)\) return null/);
  assert.match(mcp, /角色手机\|查手机\|virtual_phone\|checkphone/);
  assert.match(gateway, /sanitizeRolePhoneData\(redactJson\(task\.result/);
  assert.match(gateway, /filter\(item => !isRolePhoneRelated\(item\)\)/);
  assert.match(deepseek, /isRolePhoneExecutionTaskDenied\(task\)/);
  assert.doesNotMatch(mcp.match(/source_type: \{ type: "string", enum: \[[^\n]+/)?.[0] || "", /virtual_phone/);
});
