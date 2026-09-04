// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";

import { batchCallTranscriptChunks, buildCallCloudPayload, CALL_TRANSCRIPT_PART_CODE_POINTS } from "../lib/call-cloud-sync.ts";

function rebuild(chunks) {
  const entries = [];
  for (const chunk of chunks) {
    let entry = entries.at(-1);
    if (!entry || entry.id !== chunk.entryId) {
      entry = { id: chunk.entryId, role: chunk.role, content: "", parts: 0, expected: chunk.partCount };
      entries.push(entry);
    }
    assert.equal(chunk.partIndex, entry.parts);
    entry.content += chunk.content;
    entry.parts += 1;
  }
  for (const entry of entries) assert.equal(entry.parts, entry.expected);
  return entries.map(({ parts: _parts, expected: _expected, ...entry }) => entry);
}

test("splits and reconstructs a transcript far beyond the 30000 character event limit without loss", () => {
  const longText = "甲🙂乙".repeat(25_000);
  const transcript = [{
    id: "very-long-line", role: "assistant", content: longText,
    createdAt: "2026-08-31T05:00:00.000Z",
  }];
  const payload = buildCallCloudPayload(transcript);

  assert.ok(longText.length > 30_000);
  assert.ok(payload.chunks.length > 1);
  assert.ok(payload.chunks.every(chunk => Array.from(chunk.content).length <= CALL_TRANSCRIPT_PART_CODE_POINTS));
  assert.equal(rebuild(payload.chunks)[0].content, longText);
});

test("keeps entry order, speakers and sender identity across chunk boundaries", () => {
  const transcript = [
    { id: "u1", role: "user", content: "用户开场", createdAt: "2026-08-31T05:00:01.000Z" },
    {
      id: "a1", role: "assistant", content: "答".repeat(20_001), createdAt: "2026-08-31T05:00:02.000Z",
      senderName: "Daddy", senderCharacterId: "daddy-1",
    },
    { id: "u2", role: "user", content: "结尾", createdAt: "2026-08-31T05:00:03.000Z" },
  ];
  const payload = buildCallCloudPayload(transcript);
  const rebuilt = rebuild(payload.chunks);

  assert.deepEqual(rebuilt.map(entry => [entry.id, entry.role, entry.content]), transcript.map(entry => [entry.id, entry.role, entry.content]));
  assert.ok(payload.chunks.filter(chunk => chunk.entryId === "a1").every(chunk => (
    chunk.senderName === "Daddy" && chunk.senderCharacterId === "daddy-1"
  )));
});

test("changes transcript version when any transcript content changes", () => {
  const base = [{ id: "1", role: "user", content: "原文", createdAt: "2026-08-31T05:00:00.000Z" }];
  const changed = [{ ...base[0], content: "原文已修改" }];
  assert.notEqual(buildCallCloudPayload(base).transcriptVersion, buildCallCloudPayload(changed).transcriptVersion);
});

test("uploads more than forty transcript chunks in bounded contiguous batches without omission", () => {
  const transcript = [{
    id: "huge", role: "assistant", content: "片".repeat(CALL_TRANSCRIPT_PART_CODE_POINTS * 85 + 7),
    createdAt: "2026-08-31T05:00:00.000Z",
  }];
  const chunks = buildCallCloudPayload(transcript).chunks;
  const batches = batchCallTranscriptChunks(chunks);
  assert.ok(batches.length >= 3);
  assert.ok(batches.every(batch => batch.length <= 40));
  assert.deepEqual(batches.flat().map(chunk => chunk.chunkIndex), chunks.map(chunk => chunk.chunkIndex));
  assert.equal(rebuild(batches.flat())[0].content, transcript[0].content);
});
