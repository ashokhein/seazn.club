"use client";

// Sponsors tab manager (v10 PROMPT-56, replaces the blob editor). Rows are
// first-class `sponsors` table entries grouped by tier. One form captures
// everything — logo included, uploaded on submit — for both add and edit.
// Tiers above partner and per-competition scoping are Pro (`sponsors.tiers`);
// without it the manager is the free un-tiered strip with an upsell note.
import { useRef, useState } from "react";
import Link from "@/components/ui/console-link";
import {
  ArrowDown, ArrowUp, ImagePlus, MousePointerClick, Pencil, Trash2,
} from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import { useConfirm } from "@/components/ui/confirm-provider";
import type { MessageKey } from "@/lib/messages";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export const SPONSOR_TIERS = ["title", "gold", "silver", "partner"] as const;
export type SponsorTier = (typeof SPONSOR_TIERS)[number];

// Typed key map — the i18n house rule bans dynamic `msg()` keys.
const TIER_MSG: Record<SponsorTier, MessageKey> = {
  title: "sponsors.tier.titleTier",
  gold: "sponsors.tier.gold",
  silver: "sponsors.tier.silver",
  partner: "sponsors.tier.partner",
};

/** Client-safe mirror of the usecase SponsorRow. */
export interface SponsorItem {
  id: string;
  competition_id: string | null;
  name: string;
  url: string | null;
  logo_path: string | null;
  tier: SponsorTier;
  display_order: number;
  status: string;
  click_count: number;
  /** The paid package order that activated this placement, if any. */
  paid_order_id?: string | null;
}

const TIER_BADGE: Record<SponsorTier, string> = {
  title: "bg-amber-100 text-amber-800",
  gold: "bg-yellow-50 text-yellow-700",
  silver: "bg-slate-200 text-slate-600",
  partner: "bg-slate-100 text-slate-500",
};

interface Draft {
  name: string;
  url: string;
  tier: SponsorTier;
  competition_id: string;
  /** Picked in the form, uploaded on submit. */
  file: File | null;
  /** Object URL preview for the picked file, else the stored logo. */
  preview: string | null;
}
const EMPTY_DRAFT: Draft = {
  name: "", url: "", tier: "partner", competition_id: "", file: null, preview: null,
};

/** People type bare domains — give the link a scheme before validation. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Basic link check (field is optional): http(s), a dotted hostname, no spaces. */
function isValidSponsorUrl(raw: string): boolean {
  const normalized = normalizeUrl(raw);
  if (!normalized) return true;
  if (/\s/.test(raw.trim())) return false;
  try {
    const u = new URL(normalized);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".");
  } catch {
    return false;
  }
}

/** The one sponsor form — add and edit share it; logo travels with it.
 *  Hoisted out of OrgSponsors: a nested component definition would remount
 *  (and drop focus) on every parent render. */
function SponsorForm({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  busy,
  hasTiers,
  competitions,
  onPickLogo,
}: {
  value: Draft;
  onChange: (fn: (prev: Draft) => Draft) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
  busy: boolean;
  hasTiers: boolean;
  competitions: { id: string; name: string }[];
  onPickLogo: (file: File, set: (fn: (prev: Draft) => Draft) => void) => void;
}) {
  const msg = useMsg();
  // House uploader pattern (org-logo, prose-editor): a real button clicks a
  // ref'd hidden input — label-wrapped file inputs misfire in some browsers.
  const fileRef = useRef<HTMLInputElement>(null);
  const urlInvalid = value.url.trim() !== "" && !isValidSponsorUrl(value.url);
  return (
      <div className="flex flex-wrap items-start gap-4">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="group grid h-20 w-20 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-white text-slate-400 hover:border-purple-400 hover:text-purple-600"
          aria-label={msg("sponsors.logoLabel")}
        >
          {value.preview ? (
            // Preview is an object URL for a picked file or the stored CDN URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.preview} alt="" className="h-full w-full object-contain p-1.5" />
          ) : (
            <span className="grid place-items-center gap-1 text-center">
              <ImagePlus className="mx-auto h-5 w-5" strokeWidth={1.75} />
              <span className="px-1 text-[10px] leading-tight">{msg("sponsors.logoLabel")}</span>
            </span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPickLogo(f, onChange);
            e.target.value = "";
          }}
        />
        <div className="min-w-0 flex-1">
          {/* 2-col rows: name+link, then tier+competition; single stack on mobile. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">{msg("settings.org.sponsors.name")}</span>
              <input
                value={value.name}
                onChange={(e) => onChange((prev) => ({ ...prev, name: e.target.value }))}
                maxLength={80}
                className="input w-full"
              />
            </label>
            <label className="block">
              <span className="label">{msg("settings.org.sponsors.link")}</span>
              <input
                value={value.url}
                onChange={(e) => onChange((prev) => ({ ...prev, url: e.target.value }))}
                placeholder="https://…"
                aria-invalid={urlInvalid || undefined}
                className={`input w-full ${urlInvalid ? "border-red-400" : ""}`}
              />
              {urlInvalid ? (
                <span className="mt-1 block text-xs text-red-500">
                  {msg("sponsors.urlInvalid")}
                </span>
              ) : null}
            </label>
            {hasTiers ? (
              <label className="block">
                <span className="label">{msg("sponsors.tierLabel")}</span>
                <select
                  value={value.tier}
                  disabled={busy}
                  onChange={(e) =>
                    onChange((prev) => ({ ...prev, tier: e.target.value as SponsorTier }))
                  }
                  className="input w-full"
                >
                  {SPONSOR_TIERS.map((t) => (
                    <option key={t} value={t}>
                      {msg(TIER_MSG[t])}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {hasTiers ? (
              <label className="block">
                <span className="label">{msg("sponsors.scopeLabel")}</span>
                <select
                  value={value.competition_id}
                  disabled={busy}
                  onChange={(e) =>
                    onChange((prev) => ({ ...prev, competition_id: e.target.value }))
                  }
                  className="input w-full"
                >
                  <option value="">{msg("sponsors.scopeAll")}</option>
                  {competitions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              disabled={busy || !value.name.trim() || urlInvalid}
              onClick={onSubmit}
              className="btn btn-primary"
            >
              {busy ? "…" : submitLabel}
            </button>
            {onCancel ? (
              <button type="button" disabled={busy} onClick={onCancel} className="btn">
                {msg("confirm.cancel")}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
}

export function OrgSponsors({
  orgId,
  initialSponsors,
  competitions,
  hasTiers,
  billingHref,
  canEdit,
}: {
  orgId: string;
  initialSponsors: SponsorItem[];
  competitions: { id: string; name: string }[];
  hasTiers: boolean;
  billingHref: string;
  canEdit: boolean;
}) {
  const msg = useMsg();
  const confirm = useConfirm();
  const [sponsors, setSponsors] = useState<SponsorItem[]>(initialSponsors);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function api(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`/api/v1/orgs/${orgId}/sponsors${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: unknown;
      // v1 errors are plain strings OR structured { code, message, issues }.
      error?: string | { message?: string };
    };
    if (!res.ok) {
      const message = typeof data.error === "string" ? data.error : data.error?.message;
      throw new Error(message ?? msg("settings.saveFailed"));
    }
    // /api/v1 envelope: { ok, data } — callers want the payload.
    return data.data ?? data;
  }


  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("settings.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    const rows = (await api("", { method: "GET" })) as SponsorItem[];
    setSponsors(rows);
  }

  /** Upload a picked logo to storage; returns its public URL. */
  async function uploadLogo(file: File): Promise<string> {
    const res = await fetch(`/api/orgs/${orgId}/content-upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: file.type }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      // handler() envelope: { ok, data } — same unwrap as api().
      data?: { upload_url?: string; public_url?: string };
      error?: string;
    };
    if (!res.ok) throw new Error(json.error ?? msg("settings.org.sponsors.uploadNotAllowed"));
    const grant = json.data;
    if (!grant?.upload_url || !grant.public_url) {
      throw new Error(msg("settings.org.sponsors.uploadNotAllowed"));
    }
    const put = await fetch(grant.upload_url, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!put.ok) throw new Error(msg("settings.org.logo.uploadFailed"));
    return grant.public_url;
  }

  function pickLogo(file: File, set: (d: (prev: Draft) => Draft) => void) {
    if (file.size > MAX_LOGO_BYTES) {
      setError(msg("settings.org.sponsors.tooBig"));
      return;
    }
    setError(null);
    const preview = URL.createObjectURL(file);
    set((prev) => ({ ...prev, file, preview }));
  }

  function create() {
    void run(async () => {
      const logo_path = draft.file ? await uploadLogo(draft.file) : null;
      const url = normalizeUrl(draft.url);
      await api("", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          ...(url ? { url } : {}),
          ...(logo_path ? { logo_path } : {}),
          tier: hasTiers ? draft.tier : "partner",
          ...(hasTiers && draft.competition_id ? { competition_id: draft.competition_id } : {}),
        }),
      });
      setDraft(EMPTY_DRAFT);
      await refresh();
    });
  }

  function startEdit(s: SponsorItem) {
    setEditingId(s.id);
    setEdit({
      name: s.name,
      url: s.url ?? "",
      tier: s.tier,
      competition_id: s.competition_id ?? "",
      file: null,
      preview: s.logo_path,
    });
  }

  function saveEdit(s: SponsorItem) {
    void run(async () => {
      // Send only what changed — promoting tier / scoping is the Pro line, and
      // a no-op field must not trip the gate on a downgraded org's legacy row.
      const patch: Record<string, unknown> = {};
      if (edit.name.trim() && edit.name.trim() !== s.name) patch.name = edit.name.trim();
      const url = normalizeUrl(edit.url) || null;
      if (url !== s.url) patch.url = url;
      if (edit.tier !== s.tier) patch.tier = edit.tier;
      if ((edit.competition_id || null) !== s.competition_id) {
        patch.competition_id = edit.competition_id || null;
      }
      if (edit.file) patch.logo_path = await uploadLogo(edit.file);
      if (Object.keys(patch).length > 0) {
        await api(`/${s.id}`, { method: "PATCH", body: JSON.stringify(patch) });
        await refresh();
      }
      setEditingId(null);
    });
  }

  function remove(s: SponsorItem) {
    void (async () => {
      // A bought placement deserves a pause: deleting hides what the
      // sponsor paid for, and the money does NOT come back by itself.
      if (s.paid_order_id) {
        const ok = await confirm({
          title: msg("sponsors.deletePaid.title"),
          body: msg("sponsors.deletePaid.body", { name: s.name }),
          confirmLabel: msg("sponsors.deletePaid.label"),
          tone: "danger",
        });
        if (!ok) return;
      }
      await run(async () => {
        await api(`/${s.id}`, { method: "DELETE" });
        setSponsors((prev) => prev.filter((row) => row.id !== s.id));
      });
    })();
  }

  /** Swap within the rendered group, persist the global order. */
  function move(id: string, delta: -1 | 1) {
    const row = sponsors.find((s) => s.id === id);
    if (!row) return;
    const group = hasTiers ? sponsors.filter((s) => s.tier === row.tier) : sponsors;
    const gi = group.findIndex((s) => s.id === id);
    const target = gi + delta;
    if (gi < 0 || target < 0 || target >= group.length) return;
    const next = [...sponsors];
    const a = next.indexOf(group[gi]!);
    const b = next.indexOf(group[target]!);
    [next[a], next[b]] = [next[b]!, next[a]!];
    setSponsors(next);
    void run(async () => {
      await api("/reorder", { method: "POST", body: JSON.stringify({ ids: next.map((s) => s.id) }) });
    });
  }

  const compName = (id: string | null) =>
    id ? (competitions.find((c) => c.id === id)?.name ?? "…") : null;

  // Render in tier order; free plans see one flat partner group.
  const grouped: [SponsorTier, SponsorItem[]][] = (hasTiers ? SPONSOR_TIERS : (["partner"] as const))
    .map((tier): [SponsorTier, SponsorItem[]] => [
      tier,
      hasTiers ? sponsors.filter((s) => s.tier === tier) : sponsors,
    ])
    .filter(([, rows]) => rows.length > 0);

  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">{msg("sponsors.line")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {canEdit ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <p className="text-sm font-semibold text-slate-800">{msg("sponsors.form.title")}</p>
          <p className="mb-3 mt-0.5 text-xs text-slate-500">{msg("sponsors.form.hint")}</p>
          <SponsorForm
            value={draft}
            onChange={(fn) => setDraft(fn)}
            onSubmit={create}
            submitLabel={msg("settings.org.sponsors.add")}
            busy={busy}
            hasTiers={hasTiers}
            competitions={competitions}
            onPickLogo={pickLogo}
          />
          {!hasTiers ? (
            <p className="mt-3 text-xs text-slate-400">
              {msg("sponsors.tiersUpsell")}{" "}
              <Link href={billingHref} className="text-purple-600 underline">
                {msg("settings.upgrade.link")}
              </Link>
            </p>
          ) : null}
        </div>
      ) : null}

      {sponsors.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-400">
          {msg("sponsors.empty")}
        </p>
      ) : null}

      {grouped.map(([tier, rows]) => (
        <div key={tier}>
          {hasTiers ? (
            <p className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {msg(TIER_MSG[tier])}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${TIER_BADGE[tier]}`}>
                {rows.length}
              </span>
            </p>
          ) : null}
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
            {rows.map((s, i) => (
              <li key={s.id} className="px-3 py-2.5">
                {editingId === s.id ? (
                  <SponsorForm
                    value={edit}
                    onChange={(fn) => setEdit(fn)}
                    onSubmit={() => saveEdit(s)}
                    onCancel={() => setEditingId(null)}
                    submitLabel={msg("sponsors.save")}
                    busy={busy}
                    hasTiers={hasTiers}
                    competitions={competitions}
                    onPickLogo={pickLogo}
                  />
                ) : (
                  <div className="flex flex-wrap items-center gap-3">
                    {s.logo_path ? (
                      // Stored via content-upload — an absolute CDN URL.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.logo_path}
                        alt=""
                        className="h-9 w-9 rounded object-contain ring-1 ring-slate-200"
                      />
                    ) : (
                      <span className="grid h-9 w-9 place-items-center rounded bg-slate-100 text-xs font-semibold text-slate-400">
                        {s.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">
                        {s.name}
                        {s.paid_order_id ? (
                          // Bought through a package — ties the sponsor list
                          // back to the Sell section's orders.
                          <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase text-emerald-700">
                            {msg("sponsors.paidBadge")}
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-slate-400">
                        {compName(s.competition_id) ?? msg("sponsors.scopeAll")}
                        {s.url ? ` · ${s.url}` : ""}
                      </p>
                    </div>
                    <span
                      className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-slate-400"
                      title={msg("sponsors.clicks", { count: s.click_count })}
                      aria-label={msg("sponsors.clicks", { count: s.click_count })}
                    >
                      <MousePointerClick className="h-3.5 w-3.5" strokeWidth={1.75} />
                      {s.click_count}
                    </span>
                    {canEdit ? (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          aria-label={msg("sponsors.edit", { name: s.name })}
                          disabled={busy}
                          onClick={() => startEdit(s)}
                          className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-purple-50 hover:text-purple-700"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={msg("settings.org.sponsors.moveUp", { name: s.name })}
                          disabled={busy || i === 0}
                          onClick={() => move(s.id, -1)}
                          className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-30"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={msg("settings.org.sponsors.moveDown", { name: s.name })}
                          disabled={busy || i === rows.length - 1}
                          onClick={() => move(s.id, 1)}
                          className="grid h-7 w-7 place-items-center rounded text-slate-400 hover:bg-purple-50 hover:text-purple-700 disabled:opacity-30"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          aria-label={msg("settings.org.sponsors.remove", { name: s.name })}
                          disabled={busy}
                          onClick={() => remove(s)}
                          className="grid h-7 w-7 place-items-center rounded text-red-400 hover:bg-red-50 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
