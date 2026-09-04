export const PWA_APP_ICON_CHANGED_EVENT = "ai-phone-pwa-app-icon-changed";

const STORAGE_KEY = "ai-phone:pwa-app-icon:v1";
const ORIGINAL_ICON = "/icon-192.png";
const USER_ASSET_CACHE = "ai-phone-user-pwa-assets-v1";
const CUSTOM_ICON_URL = "/__ai_phone_pwa_icon__/icon.png";
const CUSTOM_MANIFEST_URL = "/__ai_phone_pwa_icon__/manifest.webmanifest";

export type PwaAppIconSetting = {
  mode: "original" | "custom";
  dataUrl?: string;
};

export function readPwaAppIconSetting(): PwaAppIconSetting {
  if (typeof window === "undefined") return { mode: "original" };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as PwaAppIconSetting | null;
    if (parsed?.mode === "custom" && typeof parsed.dataUrl === "string" && parsed.dataUrl.startsWith("data:image/")) return parsed;
  } catch {
    // Corrupt/legacy values fall back to the bundled icon.
  }
  return { mode: "original" };
}

export function savePwaAppIconSetting(setting: PwaAppIconSetting): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(setting));
  void applyPwaAppIcon(setting).catch(error => console.warn("[PWA] 自定义图标缓存失败", error));
  window.dispatchEvent(new CustomEvent(PWA_APP_ICON_CHANGED_EVENT, { detail: setting }));
}

export async function applyPwaAppIcon(setting = readPwaAppIconSetting()): Promise<void> {
  if (typeof document === "undefined") return;
  const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (setting.mode === "original") {
    if ("caches" in window) await caches.delete(USER_ASSET_CACHE).catch(() => false);
    document.querySelectorAll<HTMLLinkElement>('link[rel="apple-touch-icon"], link[rel="icon"]')
      .forEach(link => link.setAttribute("href", ORIGINAL_ICON));
    if (manifestLink) manifestLink.href = `/manifest.webmanifest?v=${Date.now()}`;
    return;
  }
  if (!setting.dataUrl || !("caches" in window) || !("serviceWorker" in navigator)) return;
  // Safari/installed-PWA readers need stable same-origin URLs. Blob/data URLs may
  // preview correctly in the page but are not reliable install assets.
  await navigator.serviceWorker.ready;
  const iconBlob = await fetch(setting.dataUrl).then(response => response.blob());
  const manifest = {
    name: "float",
    short_name: "float",
    description: "float",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["fullscreen", "standalone"],
    background_color: "#000000",
    theme_color: "#000000",
    orientation: "portrait",
    icons: [{ src: CUSTOM_ICON_URL, sizes: "256x256", type: "image/png", purpose: "any" }],
  };
  const cache = await caches.open(USER_ASSET_CACHE);
  await Promise.all([
    cache.put(CUSTOM_ICON_URL, new Response(iconBlob, { headers: { "Content-Type": "image/png", "Cache-Control": "no-store" } })),
    cache.put(CUSTOM_MANIFEST_URL, new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-store" } })),
  ]);
  const revision = Date.now();
  document.querySelectorAll<HTMLLinkElement>('link[rel="apple-touch-icon"], link[rel="icon"]')
    .forEach(link => link.setAttribute("href", `${CUSTOM_ICON_URL}?v=${revision}`));
  if (manifestLink) manifestLink.href = `${CUSTOM_MANIFEST_URL}?v=${revision}`;
}

export async function preparePwaAppIcon(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件");
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    const sx = Math.max(0, (image.naturalWidth - size) / 2);
    const sy = Math.max(0, (image.naturalHeight - size) / 2);
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法处理这张图片");
    context.clearRect(0, 0, 256, 256);
    context.drawImage(image, sx, sy, size, size, 0, 0, 256, 256);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}
