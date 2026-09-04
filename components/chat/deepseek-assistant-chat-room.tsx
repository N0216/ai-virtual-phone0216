"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FileUp, Image as ImageIcon, MoreHorizontal, Phone, Play, RefreshCw, Settings, Video, X } from "lucide-react";
import { simpleLLMCall } from "@/lib/api-helpers";
import { loadApiConfigs } from "@/lib/settings-storage";
import { loadDeepSeekExecutionAssistantConfig, runNextDeepSeekExecutionTask, saveDeepSeekExecutionAssistantConfig, type DeepSeekExecutionAssistantConfig } from "@/lib/deepseek-execution-assistant";
import { listExecutionTasks, type ExecutionTask, type ExecutionTaskStatus } from "@/lib/execution-handoff";
import { kvGet, kvSet } from "@/lib/kv-db";
import { startCallRecording, transcribeAudioBlob, resolveCloudSttConfig, type ActiveCallRecording } from "@/lib/stt-cloud";
import { PageShell } from "@/components/ui/page-shell";
import { EmojiPanel } from "./emoji-panel";
import { resolveMascotImageRef } from "@/lib/mascot-settings";

type Attachment = { kind: "image" | "file" | "audio"; name: string; mimeType: string; size: number; dataUrl: string };
type ChatItem = { id: string; role: "user" | "assistant"; text: string; createdAt: string; attachments?: Attachment[] };
const KEY = "ai_phone_deepseek_assistant_chat_v1";

function loadItems(): ChatItem[] { try { const value = JSON.parse(kvGet(KEY) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } }
function toDataUrl(blob: Blob): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve(String(reader.result || "")); reader.readAsDataURL(blob); }); }
function sizeLabel(size: number) { return size > 1048576 ? `${(size / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.ceil(size / 1024))}KB`; }

function AssistantSettings({ config, onSave, onClose }: { config: DeepSeekExecutionAssistantConfig; onSave: (value: DeepSeekExecutionAssistantConfig) => void; onClose: () => void }) {
  const upload = async (file: File, field: "avatarImage" | "chatBackgroundImage") => {
    const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
    const id = await saveChatImageToIndexedDB(file);
    onSave({ ...config, [field]: id });
  };
  return <PageShell title="DeepSeek助手设置" onBack={onClose} className="absolute inset-0 z-[120]">
    <div className="page-menu chat-info-menu">
      <div className="menu-group">
        <label className="menu-item"><span className="menu-label-group"><span className="menu-label">修改头像</span><span className="menu-desc">聊天列表和聊天室都会同步</span></span><span className="menu-right">选择图片</span><input hidden type="file" accept="image/*" onChange={e => { const f=e.currentTarget.files?.[0]; e.currentTarget.value=""; if(f) void upload(f,"avatarImage"); }}/></label>
        <label className="menu-item"><span className="menu-label-group"><span className="menu-label">聊天背景</span><span className="menu-desc">仅用于 DeepSeek 助手聊天室</span></span><span className="menu-right">选择图片</span><input hidden type="file" accept="image/*" onChange={e => { const f=e.currentTarget.files?.[0]; e.currentTarget.value=""; if(f) void upload(f,"chatBackgroundImage"); }}/></label>
        <label className="menu-item flex-col !items-stretch"><span className="menu-label">昵称</span><input className="ui-input" value={config.nickname || ""} onChange={e => onSave({...config,nickname:e.target.value})}/></label>
        <label className="menu-item flex-col !items-stretch"><span className="menu-label">性格与工作风格</span><span className="menu-desc">写他的性格、语气和工作习惯。低权限执行边界固定不变。</span><textarea className="ui-textarea min-h-36" value={config.personaPrompt || ""} onChange={e => onSave({...config,personaPrompt:e.target.value})}/></label>
      </div>
      <div className="menu-group"><button className="menu-item" onClick={() => onSave({...config,avatarImage:"",chatBackgroundImage:""})}><span className="menu-label text-[var(--c-danger)]">恢复默认头像和背景</span></button></div>
    </div>
  </PageShell>;
}

export function DeepSeekAssistantChatRoom({ onBack }: { onBack: () => void }) {
  const [config, setConfig] = useState(loadDeepSeekExecutionAssistantConfig);
  const [items, setItems] = useState<ChatItem[]>(loadItems);
  const [text, setText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlus, setShowPlus] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [pending, setPending] = useState<Attachment[]>([]);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle"|"recording"|"cancel"|"processing">("idle");
  const [callMode, setCallMode] = useState<"voice"|"video"|null>(null);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [backgroundUrl, setBackgroundUrl] = useState("");
  const [tasks, setTasks] = useState<ExecutionTask[]>([]);
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskError, setTaskError] = useState("");
  const recorderRef = useRef<ActiveCallRecording|null>(null);
  const pressedRef = useRef(false);
  const startYRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement|null>(null);
  const api = useMemo(() => loadApiConfigs().find(item => item.id === config.apiConfigId && item.provider.toLowerCase() === "deepseek"), [config.apiConfigId]);
  const publish = useCallback((next: ChatItem[]) => { setItems(next); kvSet(KEY, JSON.stringify(next.slice(-200))); }, []);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [items, thinking]);
  useEffect(() => { let live=true; void resolveMascotImageRef(config.avatarImage," ").then(value=>{if(live)setAvatarUrl(value.trim());}); return()=>{live=false;}; }, [config.avatarImage]);
  useEffect(() => { let live=true; void resolveMascotImageRef(config.chatBackgroundImage,"").then(value=>{if(live)setBackgroundUrl(value);}); return()=>{live=false;}; }, [config.chatBackgroundImage]);
  const saveConfig = (next: DeepSeekExecutionAssistantConfig) => { setConfig(next); saveDeepSeekExecutionAssistantConfig(next); };

  const refreshTasks = async () => { setTaskError(""); try { const statuses: ExecutionTaskStatus[]=["pending","running","succeeded","failed","cancelled"]; const groups=await Promise.all(statuses.map(status=>listExecutionTasks(status))); setTasks(groups.flat().sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,30)); } catch(error){setTaskError(error instanceof Error?error.message:String(error));} };
  useEffect(() => { if(showTasks) void refreshTasks(); }, [showTasks]);
  const runNextTask = async () => { if(taskBusy)return; setTaskBusy(true); setTaskError(""); try { const task=await runNextDeepSeekExecutionTask(config); if(!task)setTaskError(config.enabled?"现在没有等待执行的任务。":"执行助理尚未启用，请先到设置中开启。"); await refreshTasks(); } catch(error){setTaskError(error instanceof Error?error.message:String(error));} finally{setTaskBusy(false);} };

  const send = useCallback(async (overrideText?: string, overrideAttachments?: Attachment[]) => {
    const attachments=overrideAttachments ?? pending; const input=(overrideText ?? text).trim();
    if((!input&&!attachments.length)||thinking)return;
    const note=attachments.map(a=>a.kind==="image"?`[图片：${a.name}]`:a.kind==="audio"?`[语音消息：${a.name}]`:`[文件：${a.name}，${sizeLabel(a.size)}]`).join("\n");
    const user:ChatItem={id:crypto.randomUUID(),role:"user",text:[input,note].filter(Boolean).join("\n"),createdAt:new Date().toISOString(),attachments};
    const next=[...items,user]; publish(next); setText(""); setPending([]); setShowPlus(false); setShowEmoji(false);
    if(!api){publish([...next,{id:crypto.randomUUID(),role:"assistant",text:"还没有绑定 DeepSeek API，请点右上角设置进行配置。",createdAt:new Date().toISOString()}]);return;}
    setThinking(true);
    try { const response=await simpleLLMCall(api,[{role:"system",content:["你的固定身份是 DeepSeek助手，是低权限执行助理。不得冒充 Eiren/Daddy，不替他们做关系判断或感情表达，不写正式长期记忆，不绕过权限。",config.personaPrompt||"","像现实中的助理一样自然聊天。附件会以方括号说明；无法读取内容时必须诚实说明。"].join("\n")},...next.slice(-30).map(item=>({role:item.role,content:item.text}))],{temperature:.65,max_tokens:1200,usageCategory:"tool",usageLabel:"DeepSeek助手聊天"}); publish([...next,{id:crypto.randomUUID(),role:"assistant",text:response.content||response.error||"没有收到回复。",createdAt:new Date().toISOString()}]); } catch(error){publish([...next,{id:crypto.randomUUID(),role:"assistant",text:`执行失败：${error instanceof Error?error.message:String(error)}`,createdAt:new Date().toISOString()}]);} finally{setThinking(false);}
  },[api,config.personaPrompt,items,pending,publish,text,thinking]);

  const pickFiles=async(files:File[],kind:"image"|"file")=>{const next:Attachment[]=[];for(const file of files.slice(0,8)){if(file.size>12*1024*1024)continue;next.push({kind,name:file.name,mimeType:file.type||"application/octet-stream",size:file.size,dataUrl:await toDataUrl(file)});}setPending(old=>[...old,...next].slice(0,8));};
  const beginVoice=async(e:ReactPointerEvent<HTMLButtonElement>)=>{if(voiceState!=="idle")return;e.currentTarget.setPointerCapture?.(e.pointerId);pressedRef.current=true;startYRef.current=e.clientY;setVoiceState("recording");try{const recorder=await startCallRecording();if(!pressedRef.current){recorder.cancel();return;}recorderRef.current=recorder;}catch(error){pressedRef.current=false;setVoiceState("idle");alert(error instanceof Error?error.message:"无法使用麦克风");}};
  const finishVoice=async(cancel:boolean)=>{pressedRef.current=false;const recorder=recorderRef.current;recorderRef.current=null;if(!recorder){setVoiceState("idle");return;}if(cancel||voiceState==="cancel"){recorder.cancel();setVoiceState("idle");return;}setVoiceState("processing");try{const blob=await recorder.stop();if(!blob)return;const stt=resolveCloudSttConfig();const transcript=stt?await transcribeAudioBlob(blob,stt):"";await send(transcript?`[语音转写] ${transcript}`:"[语音消息]",[{kind:"audio",name:`语音-${Date.now()}.webm`,mimeType:blob.type||"audio/webm",size:blob.size,dataUrl:await toDataUrl(blob)}]);}catch(error){alert(error instanceof Error?error.message:"语音发送失败");}finally{setVoiceState("idle");}};
  const avatar = avatarUrl ? <img src={avatarUrl} alt="" /> : <span>DS</span>;
  const voiceButton = <button className="chat-hold-to-talk" onPointerDown={beginVoice} onPointerMove={e=>{if(pressedRef.current)setVoiceState(e.clientY<startYRef.current-60?"cancel":"recording");}} onPointerUp={()=>void finishVoice(false)} onPointerCancel={()=>void finishVoice(true)}>{voiceState==="recording"?"松开发送，上滑取消":voiceState==="processing"?"识别中…":"按住说话"}</button>;

  if(callMode)return <div className="absolute inset-0 z-[150] flex flex-col items-center justify-between bg-[#151515] px-6 py-16 text-white"><div className="text-center"><div className="mx-auto mb-5 grid h-24 w-24 place-items-center overflow-hidden rounded-full bg-[#2f6bff] text-3xl font-bold [&>img]:h-full [&>img]:w-full [&>img]:object-cover">{avatar}</div><h2 className="text-2xl font-semibold">{config.nickname||"DeepSeek助手"}</h2><p className="mt-2 opacity-60">{callMode==="video"?"视频通话中":"语音通话中"}</p></div><div className="w-full max-w-sm">{voiceButton}</div><button className="h-16 w-16 rounded-full bg-red-500 text-sm" onClick={()=>setCallMode(null)}>挂断</button></div>;
  return <div className="chat-room-wrapper chat-room-main-pane absolute inset-0 flex flex-col bg-[var(--c-page-body-bg)]" style={backgroundUrl?{backgroundImage:`url(${backgroundUrl})`,backgroundSize:"cover",backgroundPosition:"center"}:undefined}>
    <header className="page-header"><div className="page-header-inner"><button className="page-back-btn" onClick={onBack}>‹</button><span className="page-title">{config.nickname||"DeepSeek助手"}{thinking&&<small className="chat-typing-indicator">正在输入…</small>}</span><button type="button" className="page-header-right" aria-label="助手设置" onClick={()=>setShowSettings(true)}><MoreHorizontal size={22}/></button></div></header>
    <div ref={scrollRef} className="chat-messages-scroll flex-1 overflow-y-auto px-3 py-4">{!items.length&&<div className="chat-sys-msg mx-auto">执行助理已就位。聊天不会扩大任何工具权限。</div>}{items.map(item=><div key={item.id} className="chat-msg-wrapper" data-role={item.role}>{item.role==="assistant"&&<div className="chat-msg-avatar grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-full bg-[#2f6bff] font-bold text-white [&>img]:h-full [&>img]:w-full [&>img]:object-cover">{avatar}</div>}<div className={item.role==="user"?"chat-bubble-role-user rounded-md":"chat-bubble-role-assistant rounded-md"}>{item.attachments?.map((a,i)=>a.kind==="image"?<img key={i} src={a.dataUrl} alt={a.name} className="mb-2 max-h-64 rounded-lg object-contain"/>:a.kind==="audio"?<audio key={i} controls src={a.dataUrl}/>:<a key={i} href={a.dataUrl} download={a.name} className="mb-2 block underline">📎 {a.name} · {sizeLabel(a.size)}</a>)}{item.text}</div></div>)}</div>
    <div className="chat-input-bar chat-room-main-pane flex flex-col">{pending.length>0&&<div className="mascot-pending-files">{pending.map((a,i)=><span key={i}>{a.kind==="image"?"图片":a.name}<button onClick={()=>setPending(p=>p.filter((_,x)=>x!==i))}>×</button></span>)}</div>}<div className="chat-composer-row"><button type="button" className="ui-bare-btn chat-composer-action" onClick={()=>{setVoiceMode(v=>!v);setShowEmoji(false);setShowPlus(false);}} aria-label="语音输入">◉</button>{voiceMode?voiceButton:<textarea className="chat-input-textarea" rows={1} value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} placeholder={`跟${config.nickname||"DeepSeek助手"}聊聊…`}/>}<button type="button" className="ui-bare-btn chat-composer-action" onClick={()=>{setShowEmoji(v=>!v);setShowPlus(false);}} aria-label="表情">☺</button>{text.trim()||pending.length?<button className="chat-composer-send-button" onClick={()=>void send()} disabled={thinking}>发送</button>:<button type="button" className="ui-bare-btn chat-composer-action" onClick={()=>{setShowPlus(v=>!v);setShowEmoji(false);}} aria-label="更多功能">＋</button>}</div>
      {showPlus&&<div className="chat-plus-menu mascot-plus-menu"><label className="chat-plus-menu-item"><span className="chat-plus-icon-box"><ImageIcon size={24}/></span><span>照片</span><input hidden type="file" accept="image/*" multiple onChange={e=>{void pickFiles(Array.from(e.currentTarget.files||[]),"image");e.currentTarget.value="";}}/></label><label className="chat-plus-menu-item"><span className="chat-plus-icon-box"><FileUp size={24}/></span><span>文件</span><input hidden type="file" multiple onChange={e=>{void pickFiles(Array.from(e.currentTarget.files||[]),"file");e.currentTarget.value="";}}/></label><button className="chat-plus-menu-item" onClick={()=>setCallMode("voice")}><span className="chat-plus-icon-box"><Phone size={24}/></span><span>语音通话</span></button><button className="chat-plus-menu-item" onClick={()=>setCallMode("video")}><span className="chat-plus-icon-box"><Video size={24}/></span><span>视频通话</span></button><button className="chat-plus-menu-item" onClick={()=>setShowTasks(true)}><span className="chat-plus-icon-box"><Play size={24}/></span><span>任务交接</span></button><button className="chat-plus-menu-item" onClick={()=>setShowSettings(true)}><span className="chat-plus-icon-box"><Settings size={24}/></span><span>聊天设置</span></button></div>}{showEmoji&&<EmojiPanel onSelect={emoji=>setText(t=>t+emoji)}/>}</div>
    {showSettings&&<AssistantSettings config={config} onSave={saveConfig} onClose={()=>setShowSettings(false)}/>}
    {showTasks&&<div className="modal-overlay deepseek-task-overlay" role="dialog" aria-modal="true" aria-label="执行任务交接区"><section className="deepseek-task-sheet"><header><div><strong>Eiren → DeepSeek 任务区</strong><p>只执行任务明确授权的范围，实际工具仍逐项留痕。</p></div><button onClick={()=>setShowTasks(false)} aria-label="关闭"><X size={21}/></button></header><div className="deepseek-task-actions"><button onClick={()=>void refreshTasks()} disabled={taskBusy}><RefreshCw size={17}/>刷新</button><button className="primary" onClick={()=>void runNextTask()} disabled={taskBusy}><Play size={17}/>{taskBusy?"执行中…":"领取下一项"}</button></div>{taskError&&<div className="deepseek-task-error">{taskError}</div>}<div className="deepseek-task-list">{!tasks.length&&!taskError&&<div className="deepseek-task-empty">暂无任务记录</div>}{tasks.map(task=><article key={task.task_id} className="deepseek-task-card"><div className="deepseek-task-card-title"><span>{task.intent}</span><em data-status={task.status}>{task.status}</em></div><small>{task.task_id} · 创建者 {task.creator}</small><div className="deepseek-task-scope">范围：{task.permission_scope.length?task.permission_scope.join("、"):"无工具权限"}</div>{task.result!=null&&<pre>{typeof task.result==="string"?task.result:JSON.stringify(task.result,null,2)}</pre>}{task.error&&<div className="deepseek-task-error">{task.error}</div>}{task.tool_trace.length>0&&<details><summary>工具记录（{task.tool_trace.length}）</summary>{task.tool_trace.map((trace,index)=><div key={`${trace.tool}-${index}`} className="deepseek-tool-trace"><b>{trace.success?"✓":"×"} {trace.tool}</b><span>{trace.summary||trace.error||"已记录"}</span><small>{trace.started_at} → {trace.finished_at}</small></div>)}</details>}</article>)}</div></section></div>}
  </div>;
}
