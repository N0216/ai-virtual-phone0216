import type { StoredCallRecord, StoredCallTranscriptEntry } from "./chat-db";

export type CallTranscriptChunk = {
  chunkIndex: number;
  entryId: string;
  role: "user" | "assistant";
  createdAt: string;
  senderName?: string;
  senderCharacterId?: string;
  partIndex: number;
  partCount: number;
  content: string;
};

export type CallCloudPayload = {
  transcriptVersion: string;
  chunks: CallTranscriptChunk[];
  preview: string;
};

export const CALL_TRANSCRIPT_PART_CODE_POINTS = 8_000;
export const CALL_TRANSCRIPT_UPLOAD_BATCH = 40;

export function batchCallTranscriptChunks(chunks: CallTranscriptChunk[]): CallTranscriptChunk[][] {
  if (chunks.length === 0) return [[]];
  const batches: CallTranscriptChunk[][] = [];
  for (let index = 0; index < chunks.length; index += CALL_TRANSCRIPT_UPLOAD_BATCH) {
    batches.push(chunks.slice(index, index + CALL_TRANSCRIPT_UPLOAD_BATCH));
  }
  return batches;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function splitCodePoints(value: string, size: number): string[] {
  const points = Array.from(value);
  if (points.length === 0) return [""];
  const parts: string[] = [];
  for (let index = 0; index < points.length; index += size) parts.push(points.slice(index, index + size).join(""));
  return parts;
}

export function buildCallCloudPayload(transcript: StoredCallTranscriptEntry[]): CallCloudPayload {
  const chunks: CallTranscriptChunk[] = [];
  for (const entry of transcript) {
    const parts = splitCodePoints(entry.content, CALL_TRANSCRIPT_PART_CODE_POINTS);
    parts.forEach((content, partIndex) => chunks.push({
      chunkIndex: chunks.length,
      entryId: entry.id,
      role: entry.role,
      createdAt: entry.createdAt,
      senderName: entry.senderName,
      senderCharacterId: entry.senderCharacterId,
      partIndex,
      partCount: parts.length,
      content,
    }));
  }
  const transcriptVersion = stableHash(JSON.stringify(transcript));
  const preview = transcript.slice(-12).map(entry => (
    `${entry.role === "user" ? "用户" : entry.senderName || "角色"}：${entry.content}`
  )).join("\n").slice(0, 12_000);
  return { transcriptVersion, chunks, preview };
}

export function callRecordVersion(record: StoredCallRecord): string {
  const payload = buildCallCloudPayload(record.transcript);
  return stableHash(JSON.stringify({
    state: record.state,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    duration: record.duration,
    transcriptVersion: payload.transcriptVersion,
  }));
}
