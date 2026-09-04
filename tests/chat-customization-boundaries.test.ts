// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

test("per-session CSS rewrites chat root selectors onto the live session scope", () => {
  const source = read("lib/css-scoper.ts");
  assert.match(source, /chatRoots = \["\.chat-app", "\.chat-room-wrapper"/);
  assert.match(source, /if \(sel === root\) return scope/);
  assert.match(source, /return scope \+ " " \+ sel\.slice\(root\.length\)/);
});

test("inner monologue remains mandatory across native, custom and status-off appearances", () => {
  const source = read("lib/chat-status-region.ts");
  assert.match(source, /innerMonologueEnabled:\s*true/);
  assert.match(source, /短回复、主动消息、自动醒来与重试回复同样适用/);
  assert.match(source, /config\.mode === "off"\) return monologueEnabled \? mandatoryInner/);
  assert.match(source, /const body = "## 状态栏\\n"[\s\S]*mandatoryInner/);
});

test("turning inner monologue off removes the mandatory contract", () => {
  const source = read("components/chat/chat-settings-panel.tsx");
  const resolver = read("lib/chat-status-region.ts");
  assert.match(source, /checked=\{statusRegion\.innerMonologueEnabled !== false\}/);
  assert.match(source, /innerMonologueEnabled: c/);
  assert.match(resolver, /config\.innerMonologueEnabled !== false\s*&&\s*!config\.contract\.trim\(\)/);
  assert.match(resolver, /不要输出 \[内心\] 标签/);
  assert.match(resolver, /monologueEnabled\s*\? NATIVE_STATUS_REGION_FULL_EXAMPLE/);
  assert.match(resolver, /状态栏、内心想法（强制）、聊天消息/);
});

test("chat time supports clock, Chinese period and full formats", () => {
  const formatter = read("lib/chat-time.ts");
  const room = read("components/chat/chat-room.tsx");
  assert.match(formatter, /"smart" \| "clock" \| "period" \| "full"/);
  assert.match(formatter, /hour < 6 \? "凌晨"/);
  assert.match(room, /chat-time-divider/);
  assert.match(room, /session\.chatTimeFormat/);
});
