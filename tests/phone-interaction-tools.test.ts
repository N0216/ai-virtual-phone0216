// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  listReadablePhoneInteractions,
  projectVisibleInteractionMessage,
  readPhoneCallHistory,
  readRecentPhoneChat,
} from "../lib/phone-interaction-tools.ts";

const root = resolve(import.meta.dirname, "..");

function fixtures() {
  const sessions = [
    { id: "s-daddy", contactId: "c-daddy", unreadCount: 0, updatedAt: "2026-09-04T03:00:00.000Z", isPinned: false, lastMessagePreview: "绝不能泄露的撤回正文" },
    { id: "s-other", contactId: "c-other", unreadCount: 0, updatedAt: "2026-09-04T02:00:00.000Z", isPinned: false },
    { id: "s-blocked", contactId: "c-blocked", unreadCount: 0, updatedAt: "2026-09-04T04:00:00.000Z", isPinned: false, isBlacklisted: true },
    { id: "s-orphan", contactId: "deleted-character", unreadCount: 0, updatedAt: "2026-09-04T05:00:00.000Z", isPinned: false },
  ];
  const contacts = [
    { id: "c-daddy", characterId: "daddy", addedAt: "2026-09-01T00:00:00.000Z" },
    { id: "c-other", characterId: "other", addedAt: "2026-09-01T00:00:00.000Z" },
    { id: "c-blocked", characterId: "blocked", addedAt: "2026-09-01T00:00:00.000Z" },
  ];
  const messages = {
    "s-daddy": [
      { id: "m1", sessionId: "s-daddy", role: "user", content: "还没撤回的正常消息", status: "sent", createdAt: "2026-09-04T01:00:00.000Z" },
      { id: "m2", sessionId: "s-daddy", role: "assistant", content: "绝不能泄露的撤回正文", status: "sent", createdAt: "2026-09-04T02:00:00.000Z", isRetracted: true, rawResponseText: "绝不能泄露的撤回正文", editableResponseText: "绝不能泄露的撤回正文" },
      { id: "m3", sessionId: "s-daddy", role: "assistant", content: "现在能看到的回复", status: "sent", createdAt: "2026-09-04T03:00:00.000Z", innerMonologue: "不能给别的角色看的内心", reasoningText: "不能泄露的推理", statusPanel: "秘密状态" },
      { id: "m4", sessionId: "s-daddy", role: "tool", content: "sbp_secret_tool_value", status: "sent", createdAt: "2026-09-04T03:01:00.000Z", mediaType: "tool_result" },
    ],
    "s-other": [{ id: "o1", sessionId: "s-other", role: "user", content: "另一个会话", status: "sent", createdAt: "2026-09-04T02:00:00.000Z" }],
    "s-blocked": [{ id: "b1", sessionId: "s-blocked", role: "user", content: "黑名单秘密", status: "sent", createdAt: "2026-09-04T04:00:00.000Z" }],
    "s-orphan": [{ id: "x1", sessionId: "s-orphan", role: "user", content: "已删除好友秘密", status: "sent", createdAt: "2026-09-04T05:00:00.000Z" }],
  };
  const storedCalls = {
    "s-daddy": [{
      id: "call-new", sessionId: "s-daddy", type: "voice", initiatorRole: "user",
      startedAt: "2026-09-04T01:00:00.000Z", endedAt: "2026-09-04T01:03:00.000Z", duration: "03:00", state: "ended",
      transcript: [{ id: "t1", role: "user", content: "通话内容", createdAt: "2026-09-04T01:01:00.000Z" }],
      updatedAt: "2026-09-04T01:03:00.000Z",
    }],
  };
  const deps = {
    readSessions: async () => structuredClone(sessions),
    readContacts: async () => structuredClone(contacts),
    readMessages: async id => structuredClone(messages[id] || []),
    readStoredCalls: async id => structuredClone(storedCalls[id] || []),
    readCharacterLabels: () => ({ daddy: "Daddy", other: "其他角色", blocked: "黑名单角色" }),
    previewMessage: message => message.content,
    buildLegacyCallHistory: input => {
      assert.doesNotMatch(JSON.stringify(input), /绝不能泄露的撤回正文/);
      return [];
    },
    mergeCallHistory: (stored, legacy) => [...stored, ...legacy],
    isSessionExplicitlyReadable: session => session.id !== "s-other",
  };
  return { sessions, contacts, messages, storedCalls, deps };
}

test("a retracted message has no safe projection at all", () => {
  const projected = projectVisibleInteractionMessage({
    id: "r1", sessionId: "s", role: "assistant", content: "withdrawn secret", status: "sent",
    createdAt: "2026-09-04T00:00:00.000Z", isRetracted: true, rawResponseText: "withdrawn secret",
  });
  assert.equal(projected, null);
});

test("list derives recent preview from safe messages, never session preview or retracted content", async () => {
  const { deps } = fixtures();
  const result = await listReadablePhoneInteractions({ limit: 10 }, { characterId: "daddy" }, deps);
  assert.equal(result.success, true);
  assert.match(result.data, /现在能看到的回复/);
  assert.doesNotMatch(result.data, /绝不能泄露的撤回正文|黑名单秘密|已删除好友秘密|另一个会话/);
});

test("body and on-demand search share the same safe projection", async () => {
  const { deps } = fixtures();
  const body = await readRecentPhoneChat({ sessionName: "Daddy", limit: 30 }, { characterId: "daddy" }, deps);
  assert.equal(body.success, true);
  assert.match(body.data, /还没撤回的正常消息|现在能看到的回复/);
  assert.doesNotMatch(body.data, /绝不能泄露的撤回正文|不能给别的角色看的内心|不能泄露的推理|秘密状态|sbp_secret/);
  const search = await readRecentPhoneChat({ sessionName: "Daddy", query: "绝不能泄露", limit: 30 }, { characterId: "daddy" }, deps);
  assert.equal(search.success, true);
  assert.doesNotMatch(search.data, /绝不能泄露的撤回正文/);
  assert.match(search.data, /"消息": \[\]/);
});

test("blacklisted, removed-contact and explicitly denied sessions cannot be selected", async () => {
  const { deps } = fixtures();
  for (const sessionName of ["黑名单角色", "deleted-character", "其他角色"]) {
    const result = await readRecentPhoneChat({ sessionName }, { characterId: "daddy" }, deps);
    assert.equal(result.success, false);
  }
});

test("independent call records are returned without raw identifiers or sensitive text", async () => {
  const { deps } = fixtures();
  const result = await readPhoneCallHistory({ sessionName: "Daddy", limit: 3 }, { characterId: "daddy" }, deps);
  assert.equal(result.success, true);
  assert.match(result.data, /call-new|通话内容|03:00/);
  assert.doesNotMatch(result.data, /senderCharacterId/);
});

test("legacy call compatibility never receives a retracted chat message", async () => {
  const { deps } = fixtures();
  const result = await readPhoneCallHistory({ sessionName: "Daddy" }, { characterId: "daddy" }, deps);
  assert.equal(result.success, true);
});

test("capability is independent, default-off, role-filtered and implementation is read-only", () => {
  const capability = readFileSync(resolve(root, "lib/internal-capability-storage.ts"), "utf8");
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  const implementation = readFileSync(resolve(root, "lib/phone-interaction-tools.ts"), "utf8");
  assert.match(capability, /id: PHONE_INTERACTION_READ_CAPABILITY_ID,[\s\S]*?enabled: false,[\s\S]*?mode: "auto"/);
  assert.match(capability, /PHONE_INTERACTION_READ_SUBTOOLS/);
  assert.match(executor, /getInternalCapability\(PHONE_INTERACTION_READ_CAPABILITY_ID\)/);
  assert.match(executor, /isSupportedChatToolContext\(context\)/);
  assert.doesNotMatch(implementation, /\b(?:kvSet|kvRemove|saveChatSessions|dbPut|\.put\(|\.delete\()/);
  assert.match(implementation, /if \(message\.isRetracted\) return null/);
  assert.doesNotMatch(implementation, /session\.lastMessagePreview/);
  assert.doesNotMatch(implementation, /new Map<.*cache|searchIndex|localStorage|sessionStorage/);
});
