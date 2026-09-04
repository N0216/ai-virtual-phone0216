"use client";

import { useEffect } from "react";
import { ensurePersonalPushSubscription, hasAccountPushSubscription, peekAccountPushSubscribed } from "@/lib/push-client";

export function PWARegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    const register = () => {
      if (cancelled) return;
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error) => {
        console.warn("[PWA] Service worker registration failed:", error);
      });
      // 用户已经开启过离线推送时，每次生产启动静默核对并修复个人推送订阅。
      // iOS 更新/重装 PWA 后 PushSubscription 可能失效，但设置开关仍显示开启；
      // 不重新订阅就会出现“前台有未读、退后台或杀掉后完全没有系统通知”。
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const refresh = () => ensurePersonalPushSubscription().then(result => {
          if (!result.ok) console.warn("[PWA] personal push subscription refresh failed:", result.error);
        });
        const cached = peekAccountPushSubscribed();
        if (cached === true) void refresh();
        // 门控缓存过期不代表用户关闭了推送。先向账号服务确认，再修复
        // 当前设备订阅，避免使用一段时间后杀掉 App 就收不到通知。
        else if (cached === null) void hasAccountPushSubscription().then(subscribed => subscribed ? refresh() : undefined);
      }
    };

    if (document.readyState === "complete") {
      register();
      return () => {
        cancelled = true;
      };
    }

    window.addEventListener("load", register, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener("load", register);
    };
  }, []);

  return null;
}
