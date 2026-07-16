"use client";

// Tiered sponsor manager (v10 PROMPT-56, replaces the blob editor). Rows are
// first-class `sponsors` table entries grouped by tier; order within a group
// is display_order. Tiers above partner and per-competition scoping are Pro
// (`sponsors.tiers`) — without it the manager is the free un-tiered strip.
import { useState } from "react";
import Link from "@/components/ui/console-link";
import { ArrowDown, ArrowUp, ImagePlus, MousePointerClick, Trash2 } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
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
}

const TIER_BADGE: Record<SponsorTier, string> = {
  title: "bg-amber-100 text-amber-800",
  gold: "bg-yellow-50 text-yellow-700",
  silver: "bg-slate-200 text-slate-600",
  partner: "bg-slate-100 text-slate-500",
};

export function OrgSponsors({
  orgId,
  initialSponsors,
  competitions,
  hasTiers,
  billingHref,
}: {
  orgId: string;
  initialSponsors: SponsorItem[];
  competitions: { id: string; name: string }[];
  hasTiers: boolean;
  billingHref: string;
}) {
  const msg = useMsg();
  const [sponsors, setSponsors] = useState<SponsorItem[]>(initialSponsors);
  const [draft, setDraft] = useState({ name: "", url: "", tier: "partner" as SponsorTier, competition_id: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function api(path: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(`/api/v1/orgs/${orgId}/sponsors${path}`, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data as { error?: string }).error ?? msg("settings.saveFailed"));
    }
    return data;
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

  function create() {
    void run(async () => {
      await api("", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
          tier: hasTiers ? draft.tier : "partner",
          ...(hasTiers && draft.competition_id ? { competition_id: draft.competition_id } : {}),
        }),
      });
      setDraft({ name: "", url: "", tier: "partner", competition_id: "" });
      await refresh();
    });
  }

  function patch(id: string, body: Record<string, unknown>) {
    void run(async () => {
      await api(`/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      await refresh();
    });
  }

  function remove(id: string) {
    void run(async () => {
      await api(`/${id}`, { method: "DELETE" });
      setSponsors((prev) => prev.filter((s) => s.id !== id));
    });
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

  async function uploadLogo(id: string, file: File) {
    if (file.size > MAX_LOGO_BYTES) {
      setError(msg("settings.org.sponsors.tooBig"));
      return;
    }
    await run(async () => {
      const res = await fetch(`/api/orgs/${orgId}/content-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: file.type }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? msg("settings.org.sponsors.uploadNotAllowed"));
      const put = await fetch(data.upload_url, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) throw new Error(msg("settings.org.logo.uploadFailed"));
      await api(`/${id}`, { method: "PATCH", body: JSON.stringify({ logo_path: data.public_url }) });
      await refresh();
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
    <div className="space-y-3">
      <p className="text-sm text-slate-500">{msg("sponsors.line")}</p>
      {error && <p className="text-sm text-red-600">{error}</p>}

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
              <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                {s.logo_path ? (
                  // Upload flow stores the absolute CDN URL (content-upload).
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={s.logo_path}
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
                        if (f) void uploadLogo(s.id, f);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{s.name}</p>
                  <p className="truncate text-xs text-slate-400">
                    {compName(s.competition_id) ?? msg("sponsors.scopeAll")}
                    {s.url ? ` · ${s.url}` : ""}
                  </p>
                </div>
                {s.click_count > 0 ? (
                  <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums text-slate-400">
                    <MousePointerClick className="h-3.5 w-3.5" strokeWidth={1.75} />
                    {s.click_count}
                  </span>
                ) : null}
                {hasTiers ? (
                  <select
                    aria-label={msg("sponsors.tierLabel")}
                    value={s.tier}
                    disabled={busy}
                    onChange={(e) => patch(s.id, { tier: e.target.value })}
                    className="input h-8 w-24 px-2 py-1 text-xs"
                  >
                    {SPONSOR_TIERS.map((t) => (
                      <option key={t} value={t}>
                        {msg(TIER_MSG[t])}
                      </option>
                    ))}
                  </select>
                ) : null}
                {hasTiers ? (
                  <select
                    aria-label={msg("sponsors.scopeLabel")}
                    value={s.competition_id ?? ""}
                    disabled={busy}
                    onChange={(e) => patch(s.id, { competition_id: e.target.value || null })}
                    className="input h-8 w-36 px-2 py-1 text-xs"
                  >
                    <option value="">{msg("sponsors.scopeAll")}</option>
                    {competitions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <div className="flex shrink-0 items-center gap-0.5">
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
                    onClick={() => remove(s.id)}
                    className="grid h-7 w-7 place-items-center rounded text-red-400 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}

      <div className="flex flex-wrap items-end gap-2">
        <label className="block">
          <span className="label">{msg("settings.org.sponsors.name")}</span>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={80}
            className="input w-44"
          />
        </label>
        <label className="block">
          <span className="label">{msg("settings.org.sponsors.link")}</span>
          <input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="https://…"
            className="input w-52"
          />
        </label>
        {hasTiers ? (
          <label className="block">
            <span className="label">{msg("sponsors.tierLabel")}</span>
            <select
              value={draft.tier}
              onChange={(e) => setDraft({ ...draft, tier: e.target.value as SponsorTier })}
              className="input w-28"
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
              value={draft.competition_id}
              onChange={(e) => setDraft({ ...draft, competition_id: e.target.value })}
              className="input w-44"
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
        <button
          type="button"
          disabled={busy || !draft.name.trim() || sponsors.length >= 50}
          onClick={create}
          className="btn btn-primary"
        >
          {busy ? "…" : msg("settings.org.sponsors.add")}
        </button>
      </div>

      {!hasTiers ? (
        <p className="text-xs text-slate-400">
          {msg("sponsors.tiersUpsell")}{" "}
          <Link href={billingHref} className="text-purple-600 underline">
            {msg("settings.upgrade.link")}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
