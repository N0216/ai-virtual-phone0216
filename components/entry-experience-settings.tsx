"use client";

import { useMemo, useRef, useState } from "react";
import { FileCode2, Plus, Trash2 } from "lucide-react";

import {
  BUILTIN_SPLASH_PRESETS,
  createSplashPreset,
  getSplashPreset,
  readEntryExperienceSettings,
  writeEntryExperienceSettings,
  type EntryExperienceSettings,
  type SplashPreset,
} from "@/lib/entry-experience-storage";

type EntryExperienceSettingsProps = {
  onNotice: (text: string) => void;
};

export function EntryExperienceSettingsPage({ onNotice }: EntryExperienceSettingsProps) {
  const [settings, setSettings] = useState<EntryExperienceSettings>(() => readEntryExperienceSettings());
  const cssInputRef = useRef<HTMLInputElement>(null);

  const allPresets = useMemo(() => [...BUILTIN_SPLASH_PRESETS, ...settings.splashPresets], [settings.splashPresets]);
  const activePreset = useMemo(() => getSplashPreset(settings), [settings]);
  const activeIsCustom = settings.splashPresets.some((item) => item.id === activePreset.id);

  const persist = (next: EntryExperienceSettings, notice?: string) => {
    const saved = writeEntryExperienceSettings({ ...next, mode: "splash" });
    setSettings(saved);
    if (notice) onNotice(notice);
  };

  const updateActiveCustomPreset = (patch: Partial<SplashPreset>) => {
    if (!activeIsCustom) return;
    persist({
      ...settings,
      splashPresets: settings.splashPresets.map((item) => item.id === activePreset.id ? { ...item, ...patch } : item),
    });
  };

  const addCustomPreset = (preset = createSplashPreset()) => {
    persist({
      ...settings,
      activeSplashPresetId: preset.id,
      splashPresets: [...settings.splashPresets, preset],
    }, "已新增一套开屏方案");
  };

  const copyActivePreset = () => {
    const next = createSplashPreset(`${activePreset.name}副本`);
    next.css = activePreset.css;
    next.background = activePreset.background;
    next.foreground = activePreset.foreground;
    next.durationMs = activePreset.durationMs;
    addCustomPreset(next);
  };

  const handleCssImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 60000) {
      onNotice("CSS 文件请控制在 60KB 以内");
      return;
    }
    const preset = createSplashPreset(file.name.replace(/\.css$/i, "") || "导入的开屏");
    preset.css = await file.text();
    addCustomPreset(preset);
    onNotice("开屏 CSS 已导入，可继续修改并预览");
  };

  return (
    <div className="entry-ios-settings flex flex-col gap-5 pb-8">
      <section className="entry-ios-settings__group p-4">
        <div className="flex items-center gap-2 text-[var(--c-text-title)]">
          <FileCode2 size={18} strokeWidth={1.7} />
          <p className="m-0 text-sm font-semibold">开屏动画</p>
        </div>
        <p className="mb-0 mt-2 text-[11px] leading-relaxed text-[var(--c-icon)]">打开小手机时只播放你当前选中的开屏动画。原版始终保留，也可以复制、导入或新建多套方案。</p>

        <div className="mt-3 grid grid-cols-2 gap-2">
          {allPresets.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className={`min-h-[76px] rounded-[18px] border p-3 text-left transition ${settings.activeSplashPresetId === preset.id ? "border-[var(--c-icon-active)] bg-[var(--c-panel)]" : "border-[var(--c-card-border)] bg-[var(--c-input)]"}`}
              onClick={() => persist({ ...settings, activeSplashPresetId: preset.id })}
            >
              <span className="block text-xs font-semibold text-[var(--c-text-title)]">{preset.name}</span>
              <span className="mt-1 block text-[10px] text-[var(--c-icon)]">{preset.id.startsWith("builtin-") ? "内置 · 始终保留" : "自定义 CSS"}</span>
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <button type="button" className="entry-setting-action" onClick={() => addCustomPreset()}><Plus size={15} />新建</button>
          <button type="button" className="entry-setting-action" onClick={copyActivePreset}>复制当前</button>
          <button type="button" className="entry-setting-action" onClick={() => cssInputRef.current?.click()}><FileCode2 size={15} />导入 CSS</button>
        </div>
        <input ref={cssInputRef} type="file" accept=".css,text/css" className="hidden" onChange={handleCssImport} />

        {activeIsCustom ? (
          <div className="mt-4 flex flex-col gap-3 border-t border-[var(--c-card-border)] pt-4">
            <label className="entry-setting-field">
              <span>方案名称</span>
              <input value={activePreset.name} maxLength={40} onChange={(event) => updateActiveCustomPreset({ name: event.target.value })} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="entry-setting-field"><span>背景颜色</span><input type="color" value={activePreset.background} onChange={(event) => updateActiveCustomPreset({ background: event.target.value })} /></label>
              <label className="entry-setting-field"><span>文字/强调色</span><input type="color" value={activePreset.foreground} onChange={(event) => updateActiveCustomPreset({ foreground: event.target.value })} /></label>
            </div>
            <label className="entry-setting-field"><span>播放后自动进入：{(activePreset.durationMs / 1000).toFixed(1)} 秒</span><input type="range" min={1200} max={30000} step={100} value={activePreset.durationMs} onChange={(event) => updateActiveCustomPreset({ durationMs: Number(event.target.value) })} /></label>
            <label className="entry-setting-field"><span>开屏 CSS</span><textarea rows={12} value={activePreset.css} spellCheck={false} onChange={(event) => updateActiveCustomPreset({ css: event.target.value })} /></label>
            <button
              type="button"
              className="entry-setting-delete"
              onClick={() => persist({
                ...settings,
                activeSplashPresetId: BUILTIN_SPLASH_PRESETS[0].id,
                splashPresets: settings.splashPresets.filter((item) => item.id !== activePreset.id),
              }, "已删除这套自定义开屏")}
            >
              <Trash2 size={15} />删除这套方案
            </button>
          </div>
        ) : (
          <p className="mb-0 mt-3 text-[11px] leading-relaxed text-[var(--c-icon)]">内置方案不能被覆盖。点击“复制当前”后，可以修改副本的颜色、节奏和 CSS。</p>
        )}
      </section>
    </div>
  );
}
