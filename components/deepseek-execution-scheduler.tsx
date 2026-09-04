"use client";

import { useEffect } from "react";

import {
  loadDeepSeekExecutionAssistantConfig,
  runNextDeepSeekExecutionTask,
} from "@/lib/deepseek-execution-assistant";
import { syncUserViewReadPolicyToCloud } from "@/lib/user-view-read-cloud";

const POLL_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 5_000;

export function DeepSeekExecutionScheduler() {
  useEffect(() => {
    let stopped = false;
    let busy = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Best-effort convergence for the cloud MCP policy. The local execution
    // gate remains authoritative even when the personal cloud is offline.
    void syncUserViewReadPolicyToCloud().catch(error => {
      console.warn("[UserViewRead] startup cloud policy sync failed:", error);
    });

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      if (stopped || busy) return schedule(POLL_INTERVAL_MS);
      const config = loadDeepSeekExecutionAssistantConfig();
      if (!config.enabled) return schedule(POLL_INTERVAL_MS);
      busy = true;
      try {
        // 一次只领取一项，领取接口本身还会以 pending 状态做原子条件更新。
        await runNextDeepSeekExecutionTask(config);
      } catch (error) {
        console.warn("[DeepSeekExecutionScheduler] task poll failed:", error);
      } finally {
        busy = false;
        schedule(POLL_INTERVAL_MS);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !busy) {
        if (timer) clearTimeout(timer);
        schedule(500);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    schedule(INITIAL_DELAY_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return null;
}
