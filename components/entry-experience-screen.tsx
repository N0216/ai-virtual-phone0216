"use client";

import { useEffect, useMemo, type CSSProperties } from "react";
import { ArrowRight } from "lucide-react";

import { SplashAnimation } from "./splash-animation";
import {
  ORIGINAL_SPLASH_PRESET_ID,
  getSplashPreset,
  type EntryExperienceSettings,
} from "@/lib/entry-experience-storage";
import { scopeSessionCSS } from "@/lib/css-scoper";

type SplashScreenProps = {
  ready: boolean;
  settings: EntryExperienceSettings;
  onEnter: () => void;
};

export function SplashExperienceScreen({ ready, settings, onEnter }: SplashScreenProps) {
  const preset = getSplashPreset(settings);
  const customCss = useMemo(
    () => preset.id === ORIGINAL_SPLASH_PRESET_ID ? "" : scopeSessionCSS(preset.css, ".entry-custom-splash"),
    [preset.css, preset.id],
  );
  const style = {
    "--entry-splash-bg": preset.background,
    "--entry-splash-accent": preset.foreground,
    "--entry-splash-duration": `${preset.durationMs}ms`,
  } as CSSProperties;

  // 原版保留历史上的手动进入方式；自定义方案按用户设置的时长播放完后自动进入，
  // 同时始终保留右箭头作为跳过按钮。
  useEffect(() => {
    if (!ready || preset.id === ORIGINAL_SPLASH_PRESET_ID) return;
    const timer = window.setTimeout(onEnter, preset.durationMs);
    return () => window.clearTimeout(timer);
  }, [onEnter, preset.durationMs, preset.id, ready]);

  return (
    <main className="app-root splash-root">
      <section className="phone-shell-wrap splash-shell-wrap" aria-label="加载中">
        <div className="phone-case">
          <div className="phone-frame">
            <div className="phone-shell splash-phone-screen">
              {preset.id === ORIGINAL_SPLASH_PRESET_ID ? (
                <SplashAnimation />
              ) : (
                <div className="entry-custom-splash" style={style} data-splash-preset={preset.id}>
                  {customCss ? <style>{customCss}</style> : null}
                  <div className="entry-custom-splash__orb" aria-hidden="true" />
                  <div className="entry-custom-splash__copy">
                    <p className="entry-custom-splash__line">FLOAT / PERSONAL</p>
                    <p className="entry-custom-splash__line entry-custom-splash__line--sub">a little world, waking softly.</p>
                  </div>
                </div>
              )}
              <button
                type="button"
                className={ready ? "splash-enter-button splash-enter-button-show" : "splash-enter-button"}
                onClick={onEnter}
                disabled={!ready}
                aria-label={preset.id === ORIGINAL_SPLASH_PRESET_ID ? "进入小手机" : "跳过开屏动画"}
              >
                <ArrowRight size={18} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
