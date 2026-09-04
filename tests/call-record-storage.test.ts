// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { ReliableCallRecordWriter, loadReliableCallRecords } from "../lib/call-record-reliability.ts";

const LocalCallRecordWriter = ReliableCallRecordWriter;
const loadLocalCallRecords = loadReliableCallRecords;

class MemoryStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const input = {
  id: "call-reliability",
  sessionId: "session-1",
  type: "voice",
  initiatorRole: "user",
  startedAt: "2026-08-31T04:00:00.000Z",
  legacyStartMessageId: "start-1",
};

const completedLine = {
  id: "line-1",
  role: "user",
  content: "已经完成识别的一句",
  createdAt: "2026-08-31T04:00:10.000Z",
};

const readOnlyJournalRecord = (storage) => {
  const raw = [...storage.values.values()][0];
  return raw ? JSON.parse(raw) : null;
};

test("creates a synchronous crash journal before the first IndexedDB write settles", () => {
  const storage = new MemoryStorage();
  const neverSettles = () => new Promise(() => {});
  new LocalCallRecordWriter(input, { storage, putRecord: neverSettles });

  const record = readOnlyJournalRecord(storage);
  assert.equal(record.id, input.id);
  assert.equal(record.state, "ongoing");
  assert.deepEqual(record.transcript, []);
});

test("preserves the latest interim recognition for abnormal exit or immediate refresh", () => {
  const storage = new MemoryStorage();
  const writer = new LocalCallRecordWriter(input, {
    storage,
    putRecord: () => new Promise(() => {}),
    now: () => "2026-08-31T04:00:20.000Z",
  });
  writer.checkpointTranscript([completedLine], "最后一句还在识别");

  const record = readOnlyJournalRecord(storage);
  assert.deepEqual(record.transcript.map(line => line.content), ["已经完成识别的一句", "最后一句还在识别"]);
  assert.equal(record.transcript[1].id, `${input.id}:interim`);
});

test("retains an ended journal when IndexedDB writes fail", async () => {
  const storage = new MemoryStorage();
  const writer = new LocalCallRecordWriter(input, {
    storage,
    putRecord: async () => { throw new Error("IndexedDB unavailable"); },
  });
  writer.updateTranscript([completedLine]);

  await assert.rejects(writer.finalize("ended", "00:10"), /IndexedDB unavailable/);
  const record = readOnlyJournalRecord(storage);
  assert.equal(record.state, "ended");
  assert.equal(record.duration, "00:10");
  assert.equal(record.transcript[0].content, completedLine.content);
});

test("does not let an older successful write clear a newer crash checkpoint", async () => {
  const storage = new MemoryStorage();
  let releaseFirstWrite;
  const firstWrite = new Promise(resolve => { releaseFirstWrite = resolve; });
  const writer = new LocalCallRecordWriter(input, { storage, putRecord: () => firstWrite });
  writer.checkpointTranscript([completedLine], "更新的尾句");

  releaseFirstWrite();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(readOnlyJournalRecord(storage).transcript.map(line => line.content), [completedLine.content, "更新的尾句"]);
});

test("promotes the last interim subtitle into the final IndexedDB snapshot on hangup", async () => {
  const storage = new MemoryStorage();
  const writes = [];
  const writer = new LocalCallRecordWriter(input, {
    storage,
    putRecord: async record => { writes.push(structuredClone(record)); },
    now: () => "2026-08-31T04:00:25.000Z",
  });
  writer.checkpointTranscript([completedLine], "挂断瞬间的最后一句");
  await writer.finalize("ended", "00:25");

  assert.deepEqual(writes.at(-1).transcript.map(line => line.content), [completedLine.content, "挂断瞬间的最后一句"]);
  assert.equal(writes.at(-1).state, "ended");
  assert.equal(storage.length, 0);
});

test("completed user and AI lines survive interruption during generation or playback", async () => {
  const storage = new MemoryStorage();
  const writes = [];
  const writer = new LocalCallRecordWriter(input, {
    storage,
    putRecord: async record => { writes.push(structuredClone(record)); },
  });
  const aiLine = {
    id: "line-ai",
    role: "assistant",
    content: "AI 已生成并开始播放的一句",
    createdAt: "2026-08-31T04:00:30.000Z",
  };
  writer.updateTranscript([completedLine]);
  writer.updateTranscript([completedLine, aiLine]);
  await writer.finalize("ended", "00:30");

  assert.deepEqual(writes.at(-1).transcript.map(line => line.content), [completedLine.content, aiLine.content]);
  assert.equal(storage.length, 0);
});

test("loads the crash journal when IndexedDB cannot be read and retries repair", async () => {
  const storage = new MemoryStorage();
  const writer = new LocalCallRecordWriter(input, {
    storage,
    putRecord: () => new Promise(() => {}),
    now: () => "2026-08-31T04:00:20.000Z",
  });
  writer.checkpointTranscript([completedLine], "刷新前尾句");
  let repairAttempts = 0;

  const records = await loadLocalCallRecords(input.sessionId, {
    storage,
    getRecords: async () => { throw new Error("read failed"); },
    putRecord: async () => { repairAttempts += 1; throw new Error("still failed"); },
  });

  assert.equal(records.length, 1);
  assert.deepEqual(records[0].transcript.map(line => line.content), [completedLine.content, "刷新前尾句"]);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(repairAttempts, 1);
  assert.equal(storage.length, 1);
});
