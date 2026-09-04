"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Phone, Video } from "lucide-react";

import type { ChatSession } from "@/lib/chat-storage";
import { loadChatMessages } from "@/lib/chat-storage";
import { buildCallHistory, mergeStoredAndLegacyCallHistory, type CallHistoryRecord } from "@/lib/call-history";
import { loadLocalCallRecords } from "@/lib/call-record-storage";
import { PageShell } from "@/components/ui/page-shell";

type Props = {
  session: ChatSession;
  characterName: string;
  onClose: () => void;
};

const STATE_LABEL: Record<CallHistoryRecord["state"], string> = {
  ended: "已结束",
  cancelled: "已取消",
  rejected: "已拒绝",
  missed: "未接听",
  interrupted: "通话中断",
};

export function CallHistoryPage({ session, characterName, onClose }: Props) {
  const legacyRecords = useMemo(() => buildCallHistory(loadChatMessages(session.id)), [session.id]);
  const [records, setRecords] = useState<CallHistoryRecord[]>(legacyRecords);
  const [selected, setSelected] = useState<CallHistoryRecord | null>(null);

  useEffect(() => {
    let active = true;
    setRecords(legacyRecords);
    void loadLocalCallRecords(session.id)
      .then(stored => {
        if (active) setRecords(mergeStoredAndLegacyCallHistory(stored, legacyRecords));
      })
      .catch(error => console.warn("[CallHistory] failed to load local records:", error));
    return () => { active = false; };
  }, [legacyRecords, session.id]);

  if (selected) {
    const callLabel = selected.type === "video" ? "视频通话" : "语音通话";
    return (
      <PageShell title="通话内容" onBack={() => setSelected(null)} className="absolute inset-0 z-[10000]">
        <div className="px-4 py-4 space-y-4">
          <div className="rounded-2xl bg-[var(--c-card)] border border-[var(--c-card-border)] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <strong className="ts-14 text-[var(--c-text-title)]">{callLabel}</strong>
              <span className="ts-11 text-[var(--c-text)]">{selected.duration || STATE_LABEL[selected.state]}</span>
            </div>
            <div className="ts-11 text-[var(--c-text)] mt-1">
              {new Date(selected.startedAt).toLocaleString()} · {selected.initiatorRole === "user" ? "你发起" : `${characterName}发起`}
            </div>
          </div>
          {selected.transcript.length > 0 ? (
            <div className="space-y-3">
              {selected.transcript.map(message => (
                <div key={message.id} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[82%]">
                    <div className={`ts-10 mb-1 text-[var(--c-text)] ${message.role === "user" ? "text-right" : "text-left"}`}>
                      {message.role === "user" ? "你" : (message.senderName || characterName)}
                    </div>
                    <div className={`rounded-2xl px-3 py-2 ts-13 leading-relaxed whitespace-pre-wrap break-words ${message.role === "user" ? "bg-[var(--c-bubble-self)]" : "bg-[var(--c-bubble-other)]"}`}>
                      {message.content}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center ts-13 text-[var(--c-text)]">这通电话没有保存可展示的文字内容</div>
          )}
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="通话内容" onBack={onClose} className="absolute inset-0 z-[10000]">
      <div className="px-4 py-4 space-y-3">
        {records.length > 0 ? records.map(record => {
          const Icon = record.type === "video" ? Video : Phone;
          return (
            <button
              type="button"
              key={record.id}
              className="w-full rounded-2xl bg-[var(--c-card)] border border-[var(--c-card-border)] px-4 py-3 flex items-center gap-3 text-left"
              onClick={() => setSelected(record)}
            >
              <span className="w-10 h-10 rounded-full bg-[var(--c-input)] flex items-center justify-center shrink-0"><Icon size={19} /></span>
              <span className="min-w-0 flex-1">
                <strong className="block ts-13 font-medium text-[var(--c-text-title)]">{record.type === "video" ? "视频通话" : "语音通话"}</strong>
                <small className="block ts-11 text-[var(--c-text)] mt-1">
                  {new Date(record.startedAt).toLocaleString()} · {record.duration || STATE_LABEL[record.state]}
                </small>
              </span>
              <ChevronRight size={16} className="text-[var(--c-icon)]" />
            </button>
          );
        }) : (
          <div className="py-20 text-center ts-13 text-[var(--c-text)]">还没有通话内容</div>
        )}
      </div>
    </PageShell>
  );
}
