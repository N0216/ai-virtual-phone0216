// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { buildCallHistory, mergeStoredAndLegacyCallHistory } from "../lib/call-history.ts";

const start = {
  id: "start-1",
  sessionId: "session-1",
  role: "user",
  content: "[我向Daddy发起了语音通话]",
  status: "sent",
  createdAt: "2026-08-31T01:00:00.000Z",
};

const end = {
  id: "end-1",
  sessionId: "session-1",
  role: "user",
  content: "[我挂断了语音通话]",
  status: "sent",
  createdAt: "2026-08-31T01:05:00.000Z",
  mediaData: {
    callDuration: "05:00",
    callTranscript: [{
      id: "line-legacy",
      role: "assistant",
      content: "旧消息中的转录",
      createdAt: "2026-08-31T01:02:00.000Z",
    }],
  },
};

test("keeps legacy call records readable", () => {
  const records = buildCallHistory([start, end]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "start-1");
  assert.equal(records[0].transcript[0].content, "旧消息中的转录");
});

test("prefers the independent record and suppresses its legacy duplicate", () => {
  const legacy = buildCallHistory([start, end]);
  const stored = [{
    id: "call_start-1",
    sessionId: "session-1",
    type: "voice",
    initiatorRole: "user",
    startedAt: start.createdAt,
    endedAt: end.createdAt,
    duration: "05:00",
    state: "ended",
    transcript: [{
      id: "line-stored",
      role: "assistant",
      content: "独立记录中的转录",
      createdAt: "2026-08-31T01:02:00.000Z",
    }],
    legacyStartMessageId: start.id,
    legacyEndMessageId: end.id,
    updatedAt: end.createdAt,
  }];
  const records = mergeStoredAndLegacyCallHistory(stored, legacy);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "call_start-1");
  assert.equal(records[0].transcript[0].content, "独立记录中的转录");
});

test("shows a progressively persisted unfinished call as interrupted", () => {
  const stored = [{
    id: "call-interrupted",
    sessionId: "session-1",
    type: "video",
    initiatorRole: "assistant",
    startedAt: "2026-08-31T02:00:00.000Z",
    duration: "",
    state: "ongoing",
    transcript: [{
      id: "line-1",
      role: "user",
      content: "刷新前已经完成识别的一句话",
      createdAt: "2026-08-31T02:01:00.000Z",
    }],
    updatedAt: "2026-08-31T02:01:00.000Z",
  }];
  const records = mergeStoredAndLegacyCallHistory(stored, []);
  assert.equal(records[0].state, "interrupted");
  assert.equal(records[0].transcript[0].content, "刷新前已经完成识别的一句话");
});

test("retains unrelated legacy records while sorting newest first", () => {
  const legacy = buildCallHistory([start, end]);
  const stored = [{
    id: "call-new",
    sessionId: "session-1",
    type: "voice",
    initiatorRole: "user",
    startedAt: "2026-08-31T03:00:00.000Z",
    endedAt: "2026-08-31T03:02:00.000Z",
    duration: "02:00",
    state: "ended",
    transcript: [],
    updatedAt: "2026-08-31T03:02:00.000Z",
  }];
  const records = mergeStoredAndLegacyCallHistory(stored, legacy);
  assert.deepEqual(records.map(record => record.id), ["call-new", "start-1"]);
});
