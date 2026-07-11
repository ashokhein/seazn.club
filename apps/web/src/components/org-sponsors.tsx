"use client";

// Sponsor slots manager (v3/10 #5): name, link, logo, order — rendered on
// the public dashboard footer, the registration masthead and the slideshow.
// Organisers monetise THEIR sponsors; order here is display order there.
import { useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, Trash2 } from "lucide-react";
import type { Sponsor } from "@/lib/org-branding";
import { msg } from "@/lib/messages";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export function OrgSponsors({
  orgId,
  initialSponsors,
}: {
  orgId: string;
  initialSponsors: Sponsor[];
}) {
  const [sponsors, setSponsors] = useState<Sponsor[]>(initialSponsors);
  const [saved, setSaved] = useState(JSON.stringify(initialSponsors));
  const [draft, setDraft] = useState({ name: "", url: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function persist(next: Sponsor[]) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sponsors: next }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Save failed");
      }
      setSponsors(next);
      setSaved(JSON.stringify(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(index: number, file: File) {
    if (file.size > MAX_LOGO_BYTES) {
      setError("Sponsor logos can be up to 2 MB.");
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/orgs/${orgId}/content-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: file.type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload not allowed");
      const put = await fetch(data.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error("Upload failed");
      const next = sponsors.map((s, i) => (i === index ? { ...s, logo: data.public_url } : s));
      await persist(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    }
  }

  function move(index: number, delta: -1 | 1) {
    const next = [...sponsors];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    void persist(next);
  }

  const dirty = JSON.stringify(sponsors) !== saved;

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">{msg("sponsors.line")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {sponsors.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
          {sponsors.map((s, i) => (
            <li key={`${s.name}-${i}`} className="flex items-center gap-3 px-3 py-2">
              {s.logo ? (
                // Upload flow stores the absolute CDN URL (content-upload).
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={s.logo}
                  alt=""
                  className="h-8 w-8 rounded object-contain ring-1 ring-slate-200"
                />
              ) : (
                <label className="grid h-8 w-8 cursor-pointer place-items-center rounded bg-slate-100 text-slate-400 hover:text-purple-600">
                  <ImagePlus className="h-4 w-4" strokeWidth={1.75} />
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void uploadLogo(i, f);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-800">{s.name}</p>
                {s.url ? (
                  <p className="truncate text-xs text-slate-400">{s.url}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  aria-label={`Move ${s.name} up`}
                  disabled={busy || i === 0}
                  onClick={() => move(i, -1)}
                  className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-30"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${s.name} down`}
                  disabled={busy || i === sponsors.length - 1}
                  onClick={() => move(i, 1)}
                  className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-30"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${s.name}`}
                  disabled={busy}
                  onClick={() => void persist(sponsors.filter((_, j) => j !== i))}
                  className="grid h-7 w-7 place-items-center rounded text-red-400 hover:bg-red-50 hover:text-red-600"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="label">Sponsor name</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={80}
            className="input w-44"
          />
        </label>
        <label className="block">
          <span className="label">Link (optional)</span>
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://…"
            className="input w-52"
          />
        </label>
        <button
          type="button"
          disabled={busy || !draft.name.trim() || sponsors.length >= 12}
          onClick={() => {
            void persist([
              ...sponsors,
              { name: draft.name.trim(), ...(draft.url.trim() ? { url: draft.url.trim() } : {}) },
            ]);
            setDraft({ name: "", url: "" });
          }}
          className="btn btn-primary"
        >
          {busy ? "…" : "Add sponsor"}
        </button>
      </div>
      {dirty && <p className="text-xs text-slate-400">Saving…</p>}
    </div>
  );
}
