import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type EntryMode = "splash";

export type SplashPreset = {
  id: string;
  name: string;
  css: string;
  background: string;
  foreground: string;
  durationMs: number;
};

export type EntryExperienceSettings = {
  version: 1;
  mode: EntryMode;
  activeSplashPresetId: string;
  splashPresets: SplashPreset[];
  updatedAt: string;
};

export const ENTRY_EXPERIENCE_STORAGE_KEY = "ai_phone_entry_experience_v1";
registerKvMigration(ENTRY_EXPERIENCE_STORAGE_KEY);

export const ORIGINAL_SPLASH_PRESET_ID = "builtin-original";
export const SOFT_SPLASH_PRESET_ID = "builtin-soft";

export const BUILTIN_SPLASH_PRESETS: SplashPreset[] = [
  {
    id: ORIGINAL_SPLASH_PRESET_ID,
    name: "原版开屏",
    css: "",
    background: "#f1f2f6",
    foreground: "#174bff",
    durationMs: 9200,
  },
  {
    id: SOFT_SPLASH_PRESET_ID,
    name: "柔雾文字",
    background: "#f4f2f6",
    foreground: "#6f7890",
    durationMs: 5200,
    css: `
.entry-custom-splash {
  background:
    radial-gradient(circle at 50% 44%, color-mix(in srgb, var(--entry-splash-accent) 20%, transparent) 0, transparent 28%),
    linear-gradient(155deg, #fbfafc 0%, var(--entry-splash-bg) 100%);
}
.entry-custom-splash__orb {
  animation: entry-soft-breathe var(--entry-splash-duration) ease-in-out infinite;
}
.entry-custom-splash__line {
  animation: entry-soft-rise 1.4s cubic-bezier(.2,.75,.2,1) both;
}
.entry-custom-splash__line--sub { animation-delay: .22s; }
@keyframes entry-soft-breathe {
  0%, 100% { transform: translate(-50%, -50%) scale(.92); opacity: .58; }
  50% { transform: translate(-50%, -50%) scale(1.08); opacity: .82; }
}
@keyframes entry-soft-rise {
  from { opacity: 0; transform: translateY(14px); filter: blur(5px); }
  to { opacity: 1; transform: translateY(0); filter: blur(0); }
}`,
  },
];

export const DEFAULT_ENTRY_EXPERIENCE_SETTINGS: EntryExperienceSettings = {
  version: 1,
  mode: "splash",
  activeSplashPresetId: ORIGINAL_SPLASH_PRESET_ID,
  splashPresets: [],
  updatedAt: new Date(0).toISOString(),
};

function clampDuration(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5200;
  return Math.min(30000, Math.max(1200, Math.round(parsed)));
}

function normalizePreset(value: unknown): SplashPreset | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<SplashPreset>;
  const id = typeof source.id === "string" ? source.id.trim() : "";
  if (!id || id.startsWith("builtin-")) return null;
  return {
    id,
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim().slice(0, 40) : "自定义开屏",
    css: typeof source.css === "string" ? source.css.slice(0, 60000) : "",
    background: typeof source.background === "string" && source.background.trim() ? source.background.trim() : "#f4f2f6",
    foreground: typeof source.foreground === "string" && source.foreground.trim() ? source.foreground.trim() : "#6f7890",
    durationMs: clampDuration(source.durationMs),
  };
}

export function normalizeEntryExperienceSettings(value: unknown): EntryExperienceSettings {
  const source = value && typeof value === "object" ? value as Partial<EntryExperienceSettings> : {};
  const presets = Array.isArray(source.splashPresets)
    ? source.splashPresets.map(normalizePreset).filter((item): item is SplashPreset => Boolean(item))
    : [];
  const uniquePresets = Array.from(new Map(presets.map((item) => [item.id, item])).values());
  const validPresetIds = new Set([...BUILTIN_SPLASH_PRESETS.map((item) => item.id), ...uniquePresets.map((item) => item.id)]);
  const activeSplashPresetId = typeof source.activeSplashPresetId === "string" && validPresetIds.has(source.activeSplashPresetId)
    ? source.activeSplashPresetId
    : ORIGINAL_SPLASH_PRESET_ID;
  return {
    version: 1,
    mode: "splash",
    activeSplashPresetId,
    splashPresets: uniquePresets,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
  };
}

export function readEntryExperienceSettings(): EntryExperienceSettings {
  const raw = kvGet(ENTRY_EXPERIENCE_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_ENTRY_EXPERIENCE_SETTINGS, splashPresets: [] };
  try {
    return normalizeEntryExperienceSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_ENTRY_EXPERIENCE_SETTINGS, splashPresets: [] };
  }
}

export function writeEntryExperienceSettings(value: EntryExperienceSettings): EntryExperienceSettings {
  const normalized = normalizeEntryExperienceSettings({ ...value, updatedAt: new Date().toISOString() });
  kvSet(ENTRY_EXPERIENCE_STORAGE_KEY, JSON.stringify(normalized));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("entry-experience-updated", { detail: normalized }));
  }
  return normalized;
}

export function getSplashPreset(settings: EntryExperienceSettings): SplashPreset {
  return [...BUILTIN_SPLASH_PRESETS, ...settings.splashPresets]
    .find((item) => item.id === settings.activeSplashPresetId) ?? BUILTIN_SPLASH_PRESETS[0];
}

export function createSplashPreset(name = "自定义开屏"): SplashPreset {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `splash-${crypto.randomUUID()}`
    : `splash-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    name,
    css: BUILTIN_SPLASH_PRESETS[1].css,
    background: "#f4f2f6",
    foreground: "#6f7890",
    durationMs: 5200,
  };
}
