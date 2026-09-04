"use client";

import { useEffect } from "react";

import { getRuntimePwaDisplayMode, readPwaDisplayPreference, PWA_DISPLAY_MODE_CHANGED_EVENT } from "@/lib/pwa-display-mode";
import { applyPwaAppIcon, PWA_APP_ICON_CHANGED_EVENT } from "@/lib/pwa-app-icon";

export function PWAManifestInjector() {
  useEffect(() => {
    const root = document.documentElement;
    const displayModeQueries = ["fullscreen", "standalone", "minimal-ui"].map(mode => (
      window.matchMedia(`(display-mode: ${mode})`)
    ));
    const applyIcon = () => {
      void applyPwaAppIcon().catch(error => console.warn("[PWA] 自定义图标应用失败", error));
    };

    const syncRuntimeDisplayMode = () => {
      // 只有用户显式选了「显示系统状态栏」才挂运行时标记。iOS 装到桌面的 PWA 永远
      // 报 standalone（不支持 fullscreen），无门控会让所有 iOS 用户静默丢失虚拟状态栏。
      if (readPwaDisplayPreference(document.cookie) === "standalone") {
        root.dataset.pwaDisplayMode = getRuntimePwaDisplayMode();
      } else {
        delete root.dataset.pwaDisplayMode;
      }
    };

    const refreshManifest = () => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
      if (!link) return;
      const base = (link.getAttribute("href") || "/manifest.webmanifest").split("?")[0];
      link.setAttribute("href", `${base}?v=${Date.now()}`);
    };

    const handleSettingsChanged = () => {
      syncRuntimeDisplayMode();
      refreshManifest();
      applyIcon();
    };

    const handleIconChanged = () => applyIcon();

    syncRuntimeDisplayMode();
    refreshManifest();
    applyIcon();
    document.addEventListener("fullscreenchange", syncRuntimeDisplayMode);
    window.addEventListener("pageshow", syncRuntimeDisplayMode);
    window.addEventListener(PWA_DISPLAY_MODE_CHANGED_EVENT, handleSettingsChanged);
    window.addEventListener(PWA_APP_ICON_CHANGED_EVENT, handleIconChanged);
    displayModeQueries.forEach(query => query.addEventListener("change", syncRuntimeDisplayMode));

    return () => {
      document.removeEventListener("fullscreenchange", syncRuntimeDisplayMode);
      window.removeEventListener("pageshow", syncRuntimeDisplayMode);
      window.removeEventListener(PWA_DISPLAY_MODE_CHANGED_EVENT, handleSettingsChanged);
      window.removeEventListener(PWA_APP_ICON_CHANGED_EVENT, handleIconChanged);
      displayModeQueries.forEach(query => query.removeEventListener("change", syncRuntimeDisplayMode));
      delete root.dataset.pwaDisplayMode;
    };
  }, []);

  return null;
}
