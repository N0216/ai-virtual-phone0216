"use client";

import { useEffect, useState } from "react";
import { DEEPSEEK_ASSISTANT_UPDATED_EVENT, loadDeepSeekExecutionAssistantConfig } from "@/lib/deepseek-execution-assistant";
import { resolveMascotImageRef } from "@/lib/mascot-settings";

export function DeepSeekAssistantAvatar({ className = "" }: { className?: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    const refresh = () => { void resolveMascotImageRef(loadDeepSeekExecutionAssistantConfig().avatarImage, " ").then(value => { if (live) setUrl(value.trim()); }); };
    refresh();
    window.addEventListener(DEEPSEEK_ASSISTANT_UPDATED_EVENT, refresh);
    return () => { live = false; window.removeEventListener(DEEPSEEK_ASSISTANT_UPDATED_EVENT, refresh); };
  }, []);
  return <span className={className}>{url ? <img src={url} alt="" className="h-full w-full object-cover" /> : "DS"}</span>;
}
