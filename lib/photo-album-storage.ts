import { getThemeAssetDataUrl, saveThemeAssetFromBlob, deleteThemeAsset } from "./theme-storage";

const PHOTO_ALBUM_KEY = "ai_phone_photo_album_v1";

export type PhotoAlbumItem = {
  id: string;
  assetId: string;
  ownerType: "user" | "character";
  ownerId?: string;
  title: string;
  source: "upload" | "generated";
  allowCheckPhone: boolean;
  createdAt: number;
  mimeType: string;
};

function readItems(): PhotoAlbumItem[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(localStorage.getItem(PHOTO_ALBUM_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item): item is PhotoAlbumItem => Boolean(item?.id && item?.assetId)) : [];
  } catch {
    return [];
  }
}

function writeItems(items: PhotoAlbumItem[]): void {
  localStorage.setItem(PHOTO_ALBUM_KEY, JSON.stringify(items));
  window.dispatchEvent(new CustomEvent("photo-album-updated"));
}

export function listPhotoAlbumItems(): PhotoAlbumItem[] {
  return readItems().sort((a, b) => b.createdAt - a.createdAt);
}

export async function addPhotoAlbumItem(params: {
  blob: Blob;
  title?: string;
  ownerType?: "user" | "character";
  ownerId?: string;
  source?: "upload" | "generated";
  allowCheckPhone?: boolean;
}): Promise<PhotoAlbumItem> {
  const assetId = await saveThemeAssetFromBlob(params.blob, "photo_album");
  const item: PhotoAlbumItem = {
    id: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `photo-${Date.now()}`,
    assetId,
    ownerType: params.ownerType ?? "user",
    ownerId: params.ownerType === "character" ? params.ownerId : undefined,
    title: params.title?.trim() || "未命名照片",
    source: params.source ?? "upload",
    allowCheckPhone: params.ownerType === "character" ? Boolean(params.allowCheckPhone) : false,
    createdAt: Date.now(),
    mimeType: params.blob.type || "image/jpeg",
  };
  writeItems([item, ...readItems()]);
  return item;
}

export function updatePhotoAlbumItem(id: string, patch: Partial<Pick<PhotoAlbumItem, "title" | "allowCheckPhone">>): void {
  writeItems(readItems().map((item) => item.id === id ? { ...item, ...patch } : item));
}

export async function removePhotoAlbumItem(id: string): Promise<void> {
  const items = readItems();
  const item = items.find((entry) => entry.id === id);
  if (!item) return;
  await deleteThemeAsset(item.assetId);
  writeItems(items.filter((entry) => entry.id !== id));
}

export async function getPhotoAlbumUrl(assetId: string): Promise<string | null> {
  return getThemeAssetDataUrl(assetId);
}

export function listCheckPhoneAlbumItems(characterId: string): PhotoAlbumItem[] {
  return listPhotoAlbumItems().filter((item) => item.ownerType === "character" && item.ownerId === characterId && item.allowCheckPhone);
}
