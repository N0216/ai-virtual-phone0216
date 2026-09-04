"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, ImagePlus, Trash2 } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import { PageShell } from "@/components/ui/page-shell";
import {
  addPhotoAlbumItem,
  getPhotoAlbumUrl,
  listPhotoAlbumItems,
  removePhotoAlbumItem,
  updatePhotoAlbumItem,
  type PhotoAlbumItem,
} from "@/lib/photo-album-storage";

export function PhotoAlbumApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (message: string) => void }) {
  const characters = useMemo(() => loadCharacters(), []);
  const [items, setItems] = useState<PhotoAlbumItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [owner, setOwner] = useState("user");
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleItems = useMemo(
    () => items.filter((item) => owner === "user"
      ? item.ownerType === "user"
      : item.ownerType === "character" && item.ownerId === owner),
    [items, owner],
  );

  const refresh = () => setItems(listPhotoAlbumItems());
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    let cancelled = false;
    Promise.all(items.map(async (item) => [item.assetId, await getPhotoAlbumUrl(item.assetId)] as const)).then((rows) => {
      if (!cancelled) setUrls(Object.fromEntries(rows.filter((row): row is readonly [string, string] => Boolean(row[1]))));
    });
    return () => { cancelled = true; };
  }, [items]);

  const upload = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return onNotice?.("请选择图片文件。");
    const ownerType = owner === "user" ? "user" : "character";
    await addPhotoAlbumItem({ blob: file, title: file.name.replace(/\.[^.]+$/, ""), ownerType, ownerId: ownerType === "character" ? owner : undefined });
    refresh();
    onNotice?.("照片已保存到小手机相册。");
  };

  return (
    <PageShell
      title="相册"
      onBack={onClose}
      className="phone-settings-page bg-[var(--c-bg)] text-[var(--c-text)]"
      rightAction={<button type="button" className="ui-link-btn" onClick={() => inputRef.current?.click()}><ImagePlus size={18} /> 添加</button>}
    >
      <input ref={inputRef} hidden type="file" accept="image/*" onChange={(event) => { void upload(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      <section className="p-4">
        <p className="mb-4 text-xs opacity-60">你保存的照片与角色照片</p>
        <label className="mb-4 block text-sm">当前相册（新照片也会保存到这里）
          <select className="mt-2 w-full rounded-xl border border-black/10 bg-white/70 px-3 py-2 text-sm" value={owner} onChange={(event) => setOwner(event.target.value)}>
            <option value="user">我的相册</option>
            {characters.map((character) => <option key={character.id} value={character.id}>{character.name}的相册</option>)}
          </select>
        </label>

        {visibleItems.length === 0 ? <div className="rounded-2xl border border-dashed border-black/15 p-8 text-center text-sm opacity-60">这个相册还没有照片</div> : (
          <div className="grid grid-cols-2 gap-3">
            {visibleItems.map((item) => {
              const character = item.ownerType === "character" ? characters.find((entry) => entry.id === item.ownerId) : null;
              return <article key={item.id} className="overflow-hidden rounded-2xl border border-black/10 bg-white/60 shadow-sm">
                <div className="aspect-square bg-black/5">{urls[item.assetId] ? <img src={urls[item.assetId]} alt={item.title} className="h-full w-full object-cover" /> : null}</div>
                <div className="space-y-2 p-3">
                  <input className="w-full bg-transparent text-sm font-medium outline-none" value={item.title} onChange={(event) => { updatePhotoAlbumItem(item.id, { title: event.target.value }); refresh(); }} />
                  <div className="text-xs opacity-60">{character ? `${character.name}的相册` : "我的相册"}</div>
                  <div className="flex items-center justify-between gap-2">
                    {character ? <button type="button" className="ui-link-btn text-xs" onClick={() => { updatePhotoAlbumItem(item.id, { allowCheckPhone: !item.allowCheckPhone }); refresh(); }}>
                      {item.allowCheckPhone ? <Eye size={15} /> : <EyeOff size={15} />}{item.allowCheckPhone ? "查手机可见" : "查手机不可见"}
                    </button> : <span className="text-xs opacity-50">私人照片</span>}
                    <button type="button" className="ui-bare-btn text-red-500" aria-label="删除照片" onClick={() => { void removePhotoAlbumItem(item.id).then(refresh); }}><Trash2 size={16} /></button>
                  </div>
                </div>
              </article>;
            })}
          </div>
        )}
      </section>
    </PageShell>
  );
}
