"use client";

import { useEffect, useMemo, useState } from "react";
import { MoreHorizontal, Play, RefreshCw, X } from "lucide-react";
import { simpleLLMCall } from "@/lib/api-helpers";
import { loadApiConfigs } from "@/lib/settings-storage";
import { loadDeepSeekExecutionAssistantConfig } from "@/lib/deepseek-execution-assistant";
import { runNextDeepSeekExecutionTask } from "@/lib/deepseek-execution-assistant";
import { listExecutionTasks, type ExecutionTask, type ExecutionTaskStatus } from "@/lib/execution-handoff";
import { kvGet, kvSet } from "@/lib/kv-db";

type ChatItem = { id: string; role: "user" | "assistant"; text: string; createdAt: string };
const KEY = "ai_phone_deepseek_assistant_chat_v1";

function loadItems(): ChatItem[] {
  try { const value = JSON.parse(kvGet(KEY) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; }
}

export function DeepSeekAssistantChatRoom({ onBack }: { onBack: () => void }) {
  const config = loadDeepSeekExecutionAssistantConfig();
  const [items, setItems] = useState<ChatItem[]>(loadItems);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [tasks, setTasks] = useState<ExecutionTask[]>([]);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState("");
  const api = useMemo(() => loadApiConfigs().find(item => item.id === config.apiConfigId && item.provider.toLowerCase() === "deepseek"), [config.apiConfigId]);
  const publish = (next: ChatItem[]) => { setItems(next); kvSet(KEY, JSON.stringify(next.slice(-200))); };
  const refreshTasks = async () => {
    setTaskError("");
    try {
      const statuses: ExecutionTaskStatus[] = ["pending", "running", "succeeded", "failed", "cancelled"];
      const groups = await Promise.all(statuses.map(status => listExecutionTasks(status)));
      setTasks(groups.flat().sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 30));
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : String(error));
    }
  };
  useEffect(() => { if (showTasks) void refreshTasks(); }, [showTasks]);

  const runNextTask = async () => {
    if (taskBusy) return;
    setTaskBusy(true); setTaskError("");
    try {
      const task = await runNextDeepSeekExecutionTask(config);
      if (!task) setTaskError(config.enabled ? "现在没有等待执行的任务。" : "执行助理尚未启用，请先到设置中开启。 ");
      await refreshTasks();
    } catch (error) {
      setTaskError(error instanceof Error ? error.message : String(error));
    } finally { setTaskBusy(false); }
  };
  const send = async () => {
    const input = text.trim();
    if (!input || thinking) return;
    const user: ChatItem = { id: crypto.randomUUID(), role: "user", text: input, createdAt: new Date().toISOString() };
    const next = [...items, user]; publish(next); setText("");
    if (!api) { publish([...next, { id: crypto.randomUUID(), role: "assistant", text: "还没有绑定 DeepSeek API，请先到设置 → 聊天工具箱 → Execution Assistant 配置。", createdAt: new Date().toISOString() }]); return; }
    setThinking(true);
    try {
      const response = await simpleLLMCall(api, [
        { role: "system", content: ["你的固定身份是 DeepSeek助手，是低权限执行助理。不得冒充 Eiren/Daddy，不替他们做关系判断或感情表达，不写正式长期记忆，不绕过权限。", config.personaPrompt || "", "聊天可以正常交流；涉及实际工具执行时说明必须遵守已授权能力与任务范围，并用简洁助理口吻答复。"].join("\n") },
        ...next.slice(-30).map(item => ({ role: item.role, content: item.text })),
      ], { temperature: 0.65, max_tokens: 1200, usageCategory: "tool", usageLabel: "DeepSeek助手聊天" });
      publish([...next, { id: crypto.randomUUID(), role: "assistant", text: response.content || response.error || "没有收到回复。", createdAt: new Date().toISOString() }]);
    } catch (error) {
      publish([...next, { id: crypto.randomUUID(), role: "assistant", text: `执行失败：${error instanceof Error ? error.message : String(error)}`, createdAt: new Date().toISOString() }]);
    } finally { setThinking(false); }
  };
  return <div className="chat-room-wrapper chat-room-main-pane absolute inset-0 flex flex-col bg-[var(--c-page-body-bg)]">
    <header className="page-header"><div className="page-header-inner"><button className="page-back-btn" onClick={onBack}>‹</button><span className="page-title">DeepSeek助手{thinking && <small className="chat-typing-indicator">正在输入…</small>}</span><button type="button" className="page-header-right" aria-label="任务交接" onClick={() => setShowTasks(true)}><MoreHorizontal size={22}/></button></div></header>
    <div className="chat-messages-scroll flex-1 overflow-y-auto px-3 py-4">
      {items.length === 0 && <div className="chat-sys-msg mx-auto">执行助理已就位。聊天不会扩大任何工具权限。</div>}
      {items.map(item => <div key={item.id} className="chat-msg-wrapper" data-role={item.role}><div className={item.role === "user" ? "chat-bubble-role-user rounded-md" : "chat-bubble-role-assistant rounded-md"}>{item.text}</div></div>)}
    </div>
    <div className="chat-input-bar chat-room-main-pane"><div className="chat-composer-row"><textarea className="chat-input-textarea" rows={1} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} placeholder="跟 DeepSeek助手聊聊…"/><button className="chat-composer-send-button" onClick={() => void send()} disabled={!text.trim() || thinking}>发送</button></div></div>
    {showTasks && <div className="modal-overlay deepseek-task-overlay" role="dialog" aria-modal="true" aria-label="执行任务交接区">
      <section className="deepseek-task-sheet">
        <header><div><strong>Eiren → DeepSeek 任务区</strong><p>只执行任务明确授权的范围，实际工具仍逐项留痕。</p></div><button type="button" onClick={() => setShowTasks(false)} aria-label="关闭"><X size={21}/></button></header>
        <div className="deepseek-task-actions"><button type="button" onClick={() => void refreshTasks()} disabled={taskBusy}><RefreshCw size={17}/>刷新</button><button type="button" className="primary" onClick={() => void runNextTask()} disabled={taskBusy}><Play size={17}/>{taskBusy ? "执行中…" : "领取下一项"}</button></div>
        {taskError && <div className="deepseek-task-error">{taskError}</div>}
        <div className="deepseek-task-list">
          {tasks.length === 0 && !taskError && <div className="deepseek-task-empty">暂无任务记录</div>}
          {tasks.map(task => <article key={task.task_id} className="deepseek-task-card">
            <div className="deepseek-task-card-title"><span>{task.intent}</span><em data-status={task.status}>{task.status}</em></div>
            <small>{task.task_id} · 创建者 {task.creator}</small>
            <div className="deepseek-task-scope">范围：{task.permission_scope.length ? task.permission_scope.join("、") : "无工具权限"}</div>
            {task.result != null && <pre>{typeof task.result === "string" ? task.result : JSON.stringify(task.result, null, 2)}</pre>}
            {task.error && <div className="deepseek-task-error">{task.error}</div>}
            {task.tool_trace.length > 0 && <details><summary>工具记录（{task.tool_trace.length}）</summary>{task.tool_trace.map((trace, index) => <div key={`${trace.tool}-${index}`} className="deepseek-tool-trace"><b>{trace.success ? "✓" : "×"} {trace.tool}</b><span>{trace.summary || trace.error || "已记录"}</span><small>{trace.started_at} → {trace.finished_at}</small></div>)}</details>}
          </article>)}
        </div>
      </section>
    </div>}
  </div>;
}
