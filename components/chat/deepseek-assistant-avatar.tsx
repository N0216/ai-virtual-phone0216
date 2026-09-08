"use client";

import { useEffect, useState } from "react";
import { DEEPSEEK_ASSISTANT_UPDATED_EVENT, loadDeepSeekExecutionAssistantConfig } from "@/lib/deepseek-execution-assistant";
import { resolveMascotImageRef } from "@/lib/mascot-settings";

export function DeepSeekAssistantAvatar({ className = "" }: { className?: string }) {
  const [url, setUrl] = useState("");
  const [scale, setScale] = useState(1);
  const [positionY, setPositionY] = useState(50);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      const config = loadDeepSeekExecutionAssistantConfig();
      setScale(config.avatarScale || 1);
      setPositionY(config.avatarPositionY ?? 50);
      void resolveMascotImageRef(config.avatarImage, " ").then(value => { if (live) setUrl(value.trim()); });
    };
    refresh();
    window.addEventListener(DEEPSEEK_ASSISTANT_UPDATED_EVENT, refresh);
    return () => { live = false; window.removeEventListener(DEEPSEEK_ASSISTANT_UPDATED_EVENT, refresh); };
  }, []);
  return <span className={className}>{url ? <img src={url} alt="" className="h-full w-full object-cover" style={{ objectPosition: `50% ${positionY}%`, transform: `scale(${scale})` }} /> : "DS"}</span>;
}
