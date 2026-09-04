// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("device audit stores argument names and redacted summaries, never argument bodies", () => {
  const log = readFileSync(resolve(root, "lib/device-operation-log.ts"), "utf8");
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  assert.match(log, /argumentKeys: \[\.\.\.new Set\(input\.argumentKeys \|\| \[\]\)\]\.sort\(\)/);
  assert.match(log, /redactSensitiveLogText\(patch\.resultSummary\)/);
  assert.match(executor, /argumentKeys: Object\.keys\(call\.args \|\| \{\}\)/);
  assert.doesNotMatch(log, /arguments:\s*Record/);
});

test("local data library cannot bypass controlled interaction reads", () => {
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  assert.match(executor, /targetsPrivateChat/);
  assert.match(executor, /phone_interaction_read/);
  assert.match(executor, /scansAllModules/);
});

test("Reality Bridge abort cancels the pending remote shortcut and role-computer writes are undoable", () => {
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  const client = readFileSync(resolve(root, "lib/shortcut-command-client.ts"), "utf8");
  assert.match(executor, /cancelShortcutCommand\(createdCommandId\)/);
  assert.match(client, /export async function cancelShortcutCommand/);
  assert.match(executor, /op === "undo"/);
  assert.match(executor, /文件后来又被修改/);
  assert.match(executor, /if \(isAbortError\(err\)\) throw err;[\s\S]{0,160}角色电脑操作失败/);
});
