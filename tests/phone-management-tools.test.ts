// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  changePhoneManagementSettings,
  queryPhoneManagementState,
  sanitizePhoneManagementValue,
  undoPhoneManagementSettings,
} from "../lib/phone-management-tools.ts";

const root = resolve(import.meta.dirname, "..");

function fixtures() {
  const state = {
    theme: {
      name: "玻璃主题",
      wallpaperAssetId: "wallpaper-secret-data-id",
      wallpaperLibrary: ["a", "b"],
      wallpaperBlur: 3,
      wallpaperOpacity: 0.8,
      wallpaperScale: 105,
      wallpaperX: 48,
      wallpaperY: 52,
      fontAssetId: "font-file-data-id",
      fontFamily: "Custom Font",
      hideTopBar: true,
      statusBarDropPx: 4,
      cssOverrides: { "--c-card": "#fff", "--api-key": "sk_should_never_escape" },
      globalCustomCSS: ".secret{background:url(data:image/png;base64,AAAA)}",
      enableGlobalShadows: true,
      enableGlobalBorder: false,
    },
    entry: {
      settings: { activeSplashPresetId: "custom-one", splashPresets: [{ id: "custom-one", name: "雾", css: ".entry{color:red}", background: "#fff", foreground: "#111", durationMs: 3200 }] },
      activePreset: { id: "custom-one", name: "雾", css: ".entry{color:red}", background: "#fff", foreground: "#111", durationMs: 3200 },
    },
    desktop: {
      pages: { page1: [{ id: "chat", row: 1, col: 1 }], page2: [] },
      dock: ["settings", "theme"], folders: {},
      widgets: [{ id: "w1", type: "calendar", size: "2x2", page: 1, row: 2, col: 1 }],
      diyTemplateCount: 2,
    },
    sessions: [{
      id: "session-daddy", contactId: "contact-daddy", updatedAt: "2026-09-02T01:00:00.000Z",
      customCSS: ".chat{--token:sbp_do_not_output_this_value}", backgroundImage: "data:image/png;base64,SECRET",
      isMuted: false, bilingualTranslationEnabled: true, collapseBilingualTranslation: false,
      voiceBackground: "data:image/png;base64,CALLSECRET", voiceCallLanguage: "zh-CN", voiceCallTranslationLanguage: "en",
      voiceCallAppearance: { visualStyle: "noir", showLatinName: true, latinName: "Daddy", captionFont: "serif", orbTone: "mist" },
      callRecordStyle: "wechat", callRecordTemplates: { ended: "通话 {时长}" }, callRecordAppearance: { voiceIcon: "☎" },
    }],
    contacts: [{ id: "contact-daddy", characterId: "daddy", nickname: "Daddy" }],
    labels: { daddy: "Daddy" },
    status: { mode: "native", contract: "Bearer should-not-leak-123456789", renderHtml: "<style>secret</style>", previewRaw: "raw" },
  };
  const calls = [];
  return {
    state,
    calls,
    deps: {
      readTheme: () => { calls.push("theme"); return state.theme; },
      readEntry: async () => { calls.push("entry"); return state.entry; },
      readDesktop: async () => { calls.push("desktop"); return state.desktop; },
      readChatSessions: async () => { calls.push("sessions"); return state.sessions; },
      readChatContacts: async () => { calls.push("contacts"); return state.contacts; },
      readCharacterLabels: () => { calls.push("labels"); return state.labels; },
      readStatusRegion: (sessionId) => { calls.push(`status:${sessionId}`); return state.status; },
    },
  };
}

function writeFixtures() {
  const base = fixtures();
  const state = base.state;
  const history = [];
  const writes = [];
  let tick = 0;
  const deps = {
    readChatSessions: async () => structuredClone(state.sessions),
    readChatContacts: async () => structuredClone(state.contacts),
    readCharacterLabels: () => structuredClone(state.labels),
    writeChatSessions: async (sessions) => {
      writes.push(structuredClone(sessions));
      state.sessions = structuredClone(sessions);
    },
    readUndoHistory: () => structuredClone(history),
    writeUndoHistory: async (records) => {
      history.splice(0, history.length, ...structuredClone(records));
    },
    now: () => `2026-09-03T00:00:0${tick++}.000Z`,
    makeId: () => `undo-${tick}`,
  };
  return { state, history, writes, deps };
}

test("summary distinguishes global, session and role scopes without mutating its source data", async () => {
  const { state, deps } = fixtures();
  const before = structuredClone(state);
  const result = await queryPhoneManagementState({ scope: "summary" }, { sessionId: "session-daddy", characterId: "daddy" }, deps);
  assert.equal(result.success, true);
  assert.deepEqual(state, before);
  assert.match(result.data, /全局设置/);
  assert.match(result.data, /会话级设置/);
  assert.match(result.data, /角色级设置/);
  assert.match(result.data, /独立角色级开关/);
  assert.match(result.data, /当前不存在/);
});

test("chat and call queries resolve the current Daddy session and return summaries rather than raw assets or CSS", async () => {
  const { deps } = fixtures();
  const chat = await queryPhoneManagementState({ scope: "chat" }, { sessionId: "session-daddy", characterId: "daddy" }, deps);
  const call = await queryPhoneManagementState({ scope: "call" }, { sessionId: "session-daddy", characterId: "daddy" }, deps);
  assert.equal(chat.success, true);
  assert.equal(call.success, true);
  assert.match(chat.data, /会话级设置/);
  assert.match(chat.data, /Daddy/);
  assert.match(chat.data, /字符数/);
  assert.match(call.data, /"主要语言": "zh-CN"/);
  const combined = `${chat.data}\n${call.data}`;
  assert.doesNotMatch(combined, /sbp_do_not_output/);
  assert.doesNotMatch(combined, /data:image/);
  assert.doesNotMatch(combined, /<style>secret/);
});

test("private sessions that store the character id directly still resolve the linked role", async () => {
  const { state, deps } = fixtures();
  state.sessions[0].contactId = "daddy";
  const result = await queryPhoneManagementState(
    { scope: "call" },
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(result.success, true);
  assert.match(result.data, /"角色ID": "daddy"/);
  assert.match(result.data, /"会话名称": "Daddy"/);
});

test("scope loading is minimal and a global-only query does not touch chat records", async () => {
  const { deps, calls } = fixtures();
  const result = await queryPhoneManagementState({ scope: "appearance" }, {}, deps);
  assert.equal(result.success, true);
  assert.deepEqual(calls, ["theme"]);
});

test("an explicit unknown session never falls back to the caller's current role", async () => {
  const { deps } = fixtures();
  const result = await queryPhoneManagementState(
    { scope: "chat", sessionName: "不存在的角色" },
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(result.success, false);
  assert.match(result.error, /找不到对应聊天会话/);
});

test("sanitizer redacts sensitive keys, secret-looking values, data URLs and large strings", () => {
  const sanitized = sanitizePhoneManagementValue({
    apiKey: "sk_abcdefghijklmnopqrstuvwxyz",
    nested: { authorization: "Bearer abcdefghijklmnop", safe: "ok" },
    image: "data:image/png;base64,AAAA",
    accidental: "sbp_abcdefghijklmnopqrstuvwxyz",
    huge: "x".repeat(900),
  });
  const text = JSON.stringify(sanitized);
  assert.match(text, /已隐藏/);
  assert.match(text, /Data URL 已省略/);
  assert.match(text, /长文本已省略/);
  assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(text, /data:image/);
});

test("query implementation remains read-only and the capability remains opt-in with separate chat and auto-wake authorization", () => {
  const phoneTools = readFileSync(resolve(root, "lib/phone-management-tools.ts"), "utf8");
  const capabilities = readFileSync(resolve(root, "lib/internal-capability-storage.ts"), "utf8");
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  const toolStorage = readFileSync(resolve(root, "lib/tool-storage.ts"), "utf8");
  const policy = readFileSync(resolve(root, "lib/character-tool-policy.ts"), "utf8");

  const queryBody = phoneTools.slice(phoneTools.indexOf("export async function queryPhoneManagementState"));
  assert.doesNotMatch(queryBody, /\b(?:kvSet|kvRemove|writeThemeProfile|saveChatSessions|\.put\(|\.bulkPut\(|\.delete\()/);
  assert.match(capabilities, /id: PHONE_MANAGEMENT_CAPABILITY_ID,[\s\S]*?enabled: false,[\s\S]*?mode: "auto"/);
  assert.match(toolStorage, /internalSubToolPermissionKey\(tool\.sourceId, child\.name\)/);
  assert.match(policy, /usage === "auto_wake" \? permission\?\.autoWakeEnabled === true : permission\?\.chatEnabled === true/);
  assert.match(executor, /getInternalCapability\(PHONE_MANAGEMENT_CAPABILITY_ID\)/);
  assert.match(executor, /isSupportedChatToolContext\(context\)/);
});

test("chat settings change only whitelisted fields and creates a local undo record", async () => {
  const { state, history, deps } = writeFixtures();
  const result = await changePhoneManagementSettings(
    { scope: "chat", updates: { isMuted: true, collapseBilingualTranslation: true } },
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(result.success, true);
  assert.equal(state.sessions[0].isMuted, true);
  assert.equal(state.sessions[0].collapseBilingualTranslation, true);
  assert.equal(state.sessions[0].customCSS, ".chat{--token:sbp_do_not_output_this_value}");
  assert.equal(history.length, 1);
  assert.deepEqual(history[0].changedKeys.sort(), ["collapseBilingualTranslation", "isMuted"]);
  assert.doesNotMatch(`${result.data}${result.userNotice}`, /sbp_do_not_output|data:image/);
});

test("call settings update nested appearance without returning assets or unrelated settings", async () => {
  const { state, deps } = writeFixtures();
  const result = await changePhoneManagementSettings(
    { scope: "call", updates: { orbTone: "rose", captionFont: "rounded", showLatinName: false } },
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(result.success, true);
  assert.equal(state.sessions[0].voiceCallAppearance.orbTone, "rose");
  assert.equal(state.sessions[0].voiceCallAppearance.captionFont, "rounded");
  assert.equal(state.sessions[0].voiceCallAppearance.showLatinName, false);
  assert.equal(state.sessions[0].voiceBackground, "data:image/png;base64,CALLSECRET");
  assert.doesNotMatch(result.data, /CALLSECRET|data:image|sbp_/);
});

test("scope whitelist rejects CSS, assets, inner-monologue and cross-scope fields with zero writes", async () => {
  for (const updates of [
    { customCSS: "*{display:none}" },
    { backgroundImage: "data:image/png;base64,NO" },
    { innerMonologueEnabled: false },
    { orbTone: "rose" },
  ]) {
    const { writes, history, deps } = writeFixtures();
    const result = await changePhoneManagementSettings(
      { scope: "chat", updates },
      { sessionId: "session-daddy", characterId: "daddy" },
      deps,
    );
    assert.equal(result.success, false);
    assert.equal(writes.length, 0);
    assert.equal(history.length, 0);
  }
});

test("undo restores the previous settings and marks the record as consumed", async () => {
  const { state, history, deps } = writeFixtures();
  const changed = await changePhoneManagementSettings(
    { scope: "call", updates: { visualStyle: "original", latinName: "D" } },
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(changed.success, true);
  const undone = await undoPhoneManagementSettings(
    {},
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(undone.success, true);
  assert.equal(state.sessions[0].voiceCallAppearance.visualStyle, "noir");
  assert.equal(state.sessions[0].voiceCallAppearance.latinName, "Daddy");
  assert.ok(history[0].undoneAt);
  const twice = await undoPhoneManagementSettings({}, { sessionId: "session-daddy", characterId: "daddy" }, deps);
  assert.equal(twice.success, false);
});

test("undo restores a setting that was originally absent after JSON persistence", async () => {
  const { state, history, deps } = writeFixtures();
  state.sessions[0].voiceCallAppearance = {};
  deps.writeUndoHistory = async (records) => {
    const persisted = JSON.parse(JSON.stringify(records));
    history.splice(0, history.length, ...persisted);
  };
  const changed = await changePhoneManagementSettings(
    { scope: "call", updates: { orbTone: "rose" } },
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(changed.success, true);
  assert.equal(state.sessions[0].voiceCallAppearance.orbTone, "rose");
  const undone = await undoPhoneManagementSettings(
    {},
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(undone.success, true);
  assert.equal(state.sessions[0].voiceCallAppearance, undefined);
});

test("undo refuses to overwrite a newer manual setting", async () => {
  const { state, deps } = writeFixtures();
  await changePhoneManagementSettings(
    { scope: "chat", updates: { isMuted: true } },
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  state.sessions[0].isMuted = false;
  const result = await undoPhoneManagementSettings({}, { sessionId: "session-daddy", characterId: "daddy" }, deps);
  assert.equal(result.success, false);
  assert.match(result.error, /后来又被改过/);
  assert.equal(state.sessions[0].isMuted, false);
});

test("a failed undo-history write rolls the session settings back", async () => {
  const { state, deps } = writeFixtures();
  const before = structuredClone(state.sessions);
  deps.writeUndoHistory = async () => { throw new Error("disk full"); };
  const result = await changePhoneManagementSettings(
    { scope: "chat", updates: { isMuted: true } },
    { sessionId: "session-daddy", characterId: "daddy" },
    deps,
  );
  assert.equal(result.success, false);
  assert.deepEqual(state.sessions, before);
});

test("write permission is a separate default-off capability and executor checks it independently", () => {
  const capabilities = readFileSync(resolve(root, "lib/internal-capability-storage.ts"), "utf8");
  const executor = readFileSync(resolve(root, "lib/tool-executor.ts"), "utf8");
  assert.match(capabilities, /id: PHONE_SETTINGS_WRITE_CAPABILITY_ID,[\s\S]*?enabled: false,[\s\S]*?mode: "auto"/);
  assert.match(capabilities, /PHONE_SETTINGS_WRITE_SUBTOOLS/);
  assert.match(executor, /getInternalCapability\(PHONE_SETTINGS_WRITE_CAPABILITY_ID\)/);
  assert.match(executor, /call\.name === "修改小手机设置" \|\| call\.name === "撤销小手机设置修改"/);
});
