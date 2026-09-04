import type { ChatMessage } from "./chat-storage";
import type { StoredCallRecord } from "./chat-db";

export type CallTranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  senderName?: string;
  senderCharacterId?: string;
};

export type CallHistoryRecord = {
  id: string;
  type: "voice" | "video";
  initiatorRole: "user" | "assistant";
  startedAt: string;
  endedAt: string;
  duration: string;
  state: "ended" | "cancelled" | "rejected" | "missed" | "interrupted";
  transcript: CallTranscriptEntry[];
};

const isCallStart = (content: string) => content.includes("发起了语音通话") || content.includes("发起了视频通话");

export function buildCallHistory(messages: ChatMessage[]): CallHistoryRecord[] {
  const records: CallHistoryRecord[] = [];
  let index = 0;
  while (index < messages.length) {
    const start = messages[index];
    if (!isCallStart(start.content)) {
      index += 1;
      continue;
    }
    const type: "voice" | "video" = start.content.includes("视频通话") ? "video" : "voice";
    const keyword = type === "video" ? "视频通话" : "语音通话";
    let endIndex = -1;
    let state: CallHistoryRecord["state"] = "ended";
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const content = messages[cursor].content;
      if (isCallStart(content)) break;
      const isSameCallEnd = content.includes(keyword) && (
        content.includes("挂断了") || content.includes("取消了") || content.includes("拒绝了") || content.includes("未接听")
      );
      if (!isSameCallEnd) continue;
      endIndex = cursor;
      state = content.includes("取消了") ? "cancelled" : content.includes("拒绝了") ? "rejected" : content.includes("未接听") ? "missed" : "ended";
      break;
    }
    if (endIndex < 0) {
      index += 1;
      continue;
    }
    const end = messages[endIndex];
    const storedTranscript = end.mediaData?.callTranscript;
    const legacyTranscript: CallTranscriptEntry[] = messages
      .slice(index + 1, endIndex)
      .filter(message => message.role === "user" || message.role === "assistant")
      .map(message => ({
        id: message.id,
        role: message.role as "user" | "assistant",
        content: message.content,
        createdAt: message.createdAt,
        senderName: message.senderName,
        senderCharacterId: message.senderCharacterId,
      }));
    records.push({
      id: start.id,
      type,
      initiatorRole: start.role === "assistant" ? "assistant" : "user",
      startedAt: start.createdAt,
      endedAt: end.createdAt,
      duration: end.mediaData?.callDuration || "",
      state,
      transcript: Array.isArray(storedTranscript) ? storedTranscript : legacyTranscript,
    });
    index = endIndex + 1;
  }
  return records.reverse();
}

export function mergeStoredAndLegacyCallHistory(
  storedRecords: StoredCallRecord[],
  legacyRecords: CallHistoryRecord[],
): CallHistoryRecord[] {
  const storedStartIds = new Set(storedRecords.map(record => record.legacyStartMessageId).filter(Boolean));
  const stored = storedRecords.map<CallHistoryRecord>(record => ({
    id: record.id,
    type: record.type,
    initiatorRole: record.initiatorRole,
    startedAt: record.startedAt,
    endedAt: record.endedAt || record.updatedAt,
    duration: record.duration,
    state: record.state === "ongoing" ? "interrupted" : record.state,
    transcript: record.transcript.map(entry => ({ ...entry })),
  }));
  const compatibleLegacy = legacyRecords.filter(record => !storedStartIds.has(record.id));
  return [...stored, ...compatibleLegacy]
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());
}
