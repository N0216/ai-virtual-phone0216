"use client";

import { useEffect } from "react";
import {
  installRoleMemorySyncListeners,
  ROLE_MEMORY_SYNC_INTERVAL_MS,
  syncRoleMemoryNow,
} from "@/lib/role-memory-sync";

export function RoleMemorySyncScheduler() {
  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    const schedule = (delay = 3_000) => {
      if (cancelled) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void syncRoleMemoryNow();
      }, delay);
    };
    const uninstall = installRoleMemorySyncListeners(() => schedule());
    const interval = window.setInterval(() => schedule(0), ROLE_MEMORY_SYNC_INTERVAL_MS);
    schedule(20_000);
    return () => {
      cancelled = true;
      uninstall();
      window.clearInterval(interval);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);
  return null;
}
