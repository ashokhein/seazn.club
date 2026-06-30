"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client";

export function OrgLogo({
  orgId,
  initialLogoUrl,
}: {
  orgId: string;
  initialLogoUrl: string | null;
}) {
  const [logoUrl, setLogoUrl] = useState<string | null>(initialLogoUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFilePick(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const preview = await fileToDataUrl(file, 256);
      const { upload_url, storage_path } = await api<{
        upload_url: string;
        token: string;
        storage_path: string;
      }>(`/api/orgs/${orgId}/logo-upload-url`, { method: "POST" });

      await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": "image/webp" },
        body: file,
      });

      // Persist storage path to org record
      await api(`/api/orgs/${orgId}`, {
        method: "PATCH",
        json: { logo_storage_path: storage_path },
      });

      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      const cdnUrl = supabaseUrl
        ? `${supabaseUrl}/storage/v1/object/public/assets/${storage_path}`
        : preview;
      setLogoUrl(cdnUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="relative grid h-16 w-16 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-xl border-2 border-dashed border-purple-200 bg-purple-50 transition hover:border-purple-400 hover:bg-purple-100 disabled:cursor-not-allowed"
        aria-label="Upload org logo"
      >
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="Org logo" className="h-full w-full object-cover" />
        ) : (
          <span className="text-2xl">{busy ? "⏳" : "🏷"}</span>
        )}
        {busy && (
          <span className="absolute inset-0 flex items-center justify-center bg-white/70 text-xs text-purple-600">
            Uploading…
          </span>
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-slate-700">Organisation logo</p>
        <p className="mt-0.5 text-xs text-slate-500">
          Shown on public tournament pages and the navigation bar.
          <br />
          Click the square to upload (PNG, JPG, WebP — up to 2 MB).
        </p>
        {logoUrl && (
          <button
            type="button"
            onClick={() => {
              setLogoUrl(null);
              api(`/api/orgs/${orgId}`, {
                method: "PATCH",
                json: { logo_storage_path: null },
              }).catch(() => null);
            }}
            className="mt-1 text-xs text-red-400 underline"
          >
            Remove
          </button>
        )}
        {error && <p className="mt-1 text-xs text-red-500">{error}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onFilePick(e.target.files?.[0])}
      />
    </div>
  );
}

async function fileToDataUrl(file: File, max: number): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("bad image"));
    el.src = dataUrl;
  });
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/webp", 0.88);
}
