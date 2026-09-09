// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inspectionTargetForTool } from "../lib/execution-assistant-phone-inspection.ts";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("execution assistant inspection maps owner-view tools without ever opening role phone", () => {
  assert.deepEqual(inspectionTargetForTool("查看最近聊天"), {
    label: "正在查看获准的互动内容",
    targetApp: "chat",
  });
  assert.equal(inspectionTargetForTool("查看小手机设置").targetApp, "settings");
  assert.equal(inspectionTargetForTool("读取资料文件").targetApp, "resources");
  assert.equal(inspectionTargetForTool("未知只读工具").targetApp, null);

  for (const name of [
    "列出可查看的互动",
    "查看最近聊天",
    "查看通话内容",
    "查看小手机设置",
    "查看设备操作日志",
    "列出资料目录",
    "读取资料文件",
    "角色电脑",
    "Reality Bridge",
    "查手机",
  ]) {
    assert.notEqual(inspectionTargetForTool(name).targetApp, "checkphone", name);
  }
});

test("runner always brackets assistant work with start, step and finally restoration events", () => {
  const runner = read("lib/deepseek-execution-assistant.ts");
  assert.match(runner, /beginExecutionAssistantInspection\(/);
  assert.match(runner, /reportExecutionAssistantInspectionStep\(task\.task_id, call\.name\)/);
  assert.match(runner, /finally\s*\{[\s\S]*endExecutionAssistantInspection\(/);
});

test("desktop shell snapshots and restores the original phone interface", () => {
  const shell = read("components/desktop-shell.tsx");
  assert.match(shell, /EXECUTION_ASSISTANT_INSPECTION_START_EVENT/);
  assert.match(shell, /EXECUTION_ASSISTANT_INSPECTION_STEP_EVENT/);
  assert.match(shell, /EXECUTION_ASSISTANT_INSPECTION_END_EVENT/);
  assert.match(shell, /activeApp:\s*activeAppRef\.current/);
  assert.match(shell, /currentPageIndex:\s*currentPageIndexRef\.current/);
  assert.match(shell, /openFolderId:\s*openFolderIdRef\.current/);
  assert.match(shell, /scrollOffsets:\s*capturePhoneScrollOffsets/);
  assert.match(shell, /setActiveApp\(snapshot\.activeApp\)/);
  assert.match(shell, /restorePhoneScrollOffsets\(shellRef\.current, snapshot\.scrollOffsets\)/);
  assert.match(shell, /detail\.targetApp === "checkphone"/);
  assert.match(shell, /toolName:\s*"恢复代查前小手机界面"/);
});
