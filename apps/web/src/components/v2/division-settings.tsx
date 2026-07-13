"use client";

// Division Settings tab (v8 spec §2): General → Format → Sharing & embed →
// Danger zone, tap-per-section. The format section renders read-only once
// fixtures exist; patchDivision enforces the same rule (409 FORMAT_LOCKED),
// so hiding and enforcement can't drift.
import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";
import { divisionAccent, monogram } from "@/lib/division-hue";

export interface DivisionSettingsInfo {
  id: string;
  name: string;
  sport_key: string;
  variant_key: string;
  config: unknown;
  logo_url: string | null;
  logo_storage_path: string | null;
}

function Group({
  title,
  summary,
  defaultOpen = false,
  danger = false,
  children,
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  danger?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`card p-0 ${danger ? "border-red-200" : ""}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-2 px-5 py-3 text-left"
      >
        <span className={`text-sm font-semibold ${danger ? "text-red-700" : "text-slate-700"}`}>
          {title}
        </span>
        <span className="flex items-center gap-2">
          {summary && !open && (
            <span className="max-w-48 truncate text-xs text-slate-400">{summary}</span>
          )}
          <span aria-hidden className="text-xs text-slate-400">{open ? "▾" : "▸"}</span>
        </span>
      </button>
      {open && <div className="space-y-3 px-5 pb-5">{children}</div>}
    </section>
  );
}

async function fileToWebp(file: File, max: number): Promise<Blob> {
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
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.88),
  );
  if (!blob) throw new Error("image conversion failed");
  return blob;
}

export function DivisionSettings({
  division,
  variants,
  locked,
  canEdit,
  fixturesHref,
  embed,
  danger,
}: {
  division: DivisionSettingsInfo;
  variants: { key: string; name: string }[];
  /** formatLocked() from the page — fixtures exist. */
  locked: boolean;
  canEdit: boolean;
  fixturesHref: string;
  /** Server-rendered EmbedSnippet (or the private-comp note). */
  embed: ReactNode;
  /** DivisionDangerZone, unchanged. */
  danger: ReactNode;
}) {
  const router = useRouter();
  const [name, setName] = useState(division.name);
  const [logoUrl, setLogoUrl] = useState(division.logo_url);
  const [variantKey, setVariantKey] = useState(division.variant_key);
  const [configText, setConfigText] = useState(JSON.stringify(division.config ?? {}, null, 2));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hue = divisionAccent(division.id);

  async function run(fn: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(done);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const saveName = () =>
    run(async () => {
      await apiV1(`/api/v1/divisions/${division.id}`, { method: "PATCH", json: { name: name.trim() } });
    }, "Name saved.");

  const uploadLogo = (file: File | undefined) => {
    if (!file) return;
    void run(async () => {
      const webp = await fileToWebp(file, 512);
      const { upload_url, storage_path } = await apiV1<{
        upload_url: string;
        storage_path: string;
      }>(`/api/v1/divisions/${division.id}/logo-upload-url`, { method: "POST", json: {} });
      const put = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": "image/webp" },
        body: webp,
      });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { logo_storage_path: storage_path },
      });
      const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
      setLogoUrl(base ? `${base}/storage/v1/object/public/assets/${storage_path}` : null);
    }, "Logo uploaded — the card tile uses it now.");
  };

  const removeLogo = () =>
    run(async () => {
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { logo_storage_path: null },
      });
      setLogoUrl(null);
    }, "Logo removed — the tile shows the monogram again.");

  const applyFormat = () =>
    run(async () => {
      let config: unknown;
      try {
        config = JSON.parse(configText);
      } catch {
        throw new Error("Config is not valid JSON");
      }
      await apiV1(`/api/v1/divisions/${division.id}`, {
        method: "PATCH",
        json: { variant_key: variantKey, config },
      });
    }, "Format updated.");

  return (
    <div className="max-w-2xl space-y-3" data-testid="division-settings">
      <Group title="General" defaultOpen summary={division.name}>
        <label className="block text-xs text-slate-500">
          Division name
          <input
            disabled={!canEdit}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input mt-1 w-full"
          />
        </label>
        {canEdit && (
          <button
            type="button"
            disabled={busy || name.trim() === "" || name.trim() === division.name}
            onClick={saveName}
            className="btn btn-primary text-xs"
          >
            Save name
          </button>
        )}

        <div className="flex items-center gap-4 border-t border-slate-100 pt-3">
          {/* Live card-tile preview: logo, else monogram in the accent hue. */}
          <span
            aria-hidden
            data-testid="settings-tile-preview"
            className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg"
            style={
              logoUrl
                ? undefined
                : { backgroundColor: `color-mix(in srgb, ${hue} 15%, white)`, color: hue }
            }
          >
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- tenant upload
              <img src={logoUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-xl font-bold">{monogram(name || division.name)}</span>
            )}
          </span>
          <div className="min-w-0 flex-1 text-xs text-slate-500">
            <p className="font-medium text-slate-700">Card logo</p>
            <p className="mt-0.5">
              Shows on this division&apos;s card. Without one, the card wears the monogram.
            </p>
            {canEdit && (
              <span className="mt-1 flex gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                  className="text-purple-700 underline"
                >
                  Upload image
                </button>
                {logoUrl && (
                  <button type="button" disabled={busy} onClick={removeLogo} className="text-red-500 underline">
                    Remove
                  </button>
                )}
              </span>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => uploadLogo(e.target.files?.[0])}
          />
        </div>
      </Group>

      <Group
        title="Format"
        summary={`${division.sport_key} · ${locked ? `${division.variant_key} (locked)` : division.variant_key}`}
      >
        {locked ? (
          <div data-testid="format-locked" className="rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            <p className="font-medium text-slate-700">
              {division.sport_key} · {division.variant_key}
            </p>
            <p className="mt-1">
              Format is locked — fixtures exist. Delete the stages first if you must change it
              (<Link href={fixturesHref} className="text-purple-700 underline">Fixtures</Link>).
            </p>
          </div>
        ) : (
          <>
            <label className="block text-xs text-slate-500">
              Variant
              <select
                disabled={!canEdit}
                value={variantKey}
                onChange={(e) => setVariantKey(e.target.value)}
                className="input mt-1 w-full"
              >
                {variants.map((v) => (
                  <option key={v.key} value={v.key}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-slate-500">
              Config (advanced — validated by the sport module on save)
              <textarea
                disabled={!canEdit}
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
                rows={6}
                spellCheck={false}
                className="input mt-1 w-full font-mono text-xs"
              />
            </label>
            {canEdit && (
              <button type="button" disabled={busy} onClick={applyFormat} className="btn btn-primary text-xs">
                Apply format
              </button>
            )}
            <p className="text-[11px] text-slate-400">
              Changing the format re-validates against the sport&apos;s rules. Once fixtures are
              generated it locks for good.
            </p>
          </>
        )}
      </Group>

      <Group title="Sharing & embed" summary="Widgets for your website">
        {embed}
      </Group>

      <Group title="Danger zone" summary="Archive or delete" danger>
        {danger}
      </Group>

      {notice && <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
