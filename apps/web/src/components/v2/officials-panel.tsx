"use client";

// Officials console (Jul3/02 §5): palette + auto/apply proposal feeding the
// schedule, per-fixture manual assign with lock, phased sourcing affordance,
// hide-names toggle. Keyboard-accessible; conflict badges mirror doc 12 §2
// block/warn.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { officialRolePreset } from "@/lib/official-roles";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg, useLocale } from "@/components/i18n/dict-provider";

interface Official {
  id: string;
  display_name: string;
  role_keys: string[];
  entrant_id: string | null;
  max_per_day: number | null;
}
interface FixtureLite {
  id: string;
  label: string;
  scheduled_at: string | null;
  officials: { official_id: string; name: string; role: string; locked: boolean }[];
}
interface StageLite {
  id: string;
  name: string;
  seq: number;
}
interface Proposal {
  assignments: { fixtureId: string; officialId: string; roleKey: string; locked?: boolean }[];
  conflicts: {
    kind: string;
    severity: "block" | "warn";
    fixtureId?: string;
    detail?: string;
  }[];
}
interface Sourced {
  resolved: { entrant_id: string; display_name: string; official_id: string | null }[];
  pending: { reason: string }[];
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

const AVATAR_COLORS = ["#7c3aed", "#0891b2", "#db2777", "#ea580c", "#16a34a", "#2563eb", "#9333ea", "#c2410c"];
function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

export function OfficialsPanel({
  divisionId,
  officials,
  fixtures,
  stages,
  hideNames,
  canEdit,
  sportKey,
}: {
  divisionId: string;
  officials: Official[];
  fixtures: FixtureLite[];
  stages: StageLite[];
  hideNames: boolean;
  canEdit: boolean;
  /** Seeds the add-form role + crew hint from the sport's preset (v6/00 §4). */
  sportKey?: string;
}) {
  const msg = useMsg();
  const locale = useLocale();
  const rolePreset = officialRolePreset(sportKey);
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [roles, setRoles] = useState(rolePreset.defaultRole);
  const [blockStay, setBlockStay] = useState(true);
  const [poolLock, setPoolLock] = useState(false);
  const [fairness, setFairness] = useState<"tournament" | "per_day">("tournament");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [sourceStage, setSourceStage] = useState(stages[0]?.id ?? "");
  const [sourceRank, setSourceRank] = useState(4);
  const [sourced, setSourced] = useState<Sourced | null>(null);

  const officialName = (id: string) =>
    officials.find((o) => o.id === id)?.display_name ?? id;

  async function run(fn: () => Promise<unknown>, refresh = true) {
    setError(null);
    setPaywallFeature(null);
    setBusy(true);
    try {
      await fn();
      if (refresh) router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : msg("officials.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  const roleList = roles.split(/[,\s]+/).filter(Boolean);

  return (
    <section className="mt-8 space-y-4" aria-label={msg("officials.aria")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">{msg("officials.heading")}</h2>
        {canEdit && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={hideNames}
              disabled={busy}
              onChange={(e) =>
                void run(() =>
                  apiV1(`/api/v1/divisions/${divisionId}`, {
                    method: "PATCH",
                    json: { officials_hide_names: e.target.checked },
                  }),
                )
              }
            />
            {msg("officials.hideNames")}
          </label>
        )}
      </div>

      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {/* roster of officials */}
      <div className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">{msg("officials.roster")}</h3>
          {officials.length > 0 && (
            <span className="text-xs text-slate-400">{msg("officials.total", { n: officials.length })}</span>
          )}
        </div>
        {officials.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-200 px-3 py-6 text-center text-sm text-slate-500">
            {msg("officials.empty")}
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {officials.map((o) => (
              <li
                key={o.id}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-2.5"
              >
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-xs font-semibold text-white"
                  style={{ backgroundColor: avatarColor(o.display_name) }}
                  aria-hidden
                >
                  {initials(o.display_name)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{o.display_name}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1">
                    {o.role_keys.map((r) => (
                      <span
                        key={r}
                        className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] capitalize text-slate-500"
                      >
                        {r}
                      </span>
                    ))}
                    {o.entrant_id && (
                      <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] text-violet-600">
                        {msg("officials.teamRef")}
                      </span>
                    )}
                  </div>
                </div>
                {o.max_per_day != null && (
                  <span className="shrink-0 text-[11px] text-slate-400">
                    {msg("officials.maxPerDay", { n: o.max_per_day })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <form
            className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void run(async () => {
                await apiV1("/api/v1/officials", {
                  method: "POST",
                  json: {
                    display_name: name.trim(),
                    role_keys: roleList.length ? roleList : [rolePreset.defaultRole],
                  },
                });
                setName("");
              });
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              {msg("officials.name")}
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              {msg("officials.roles")}
              <input className="input w-40" value={roles} onChange={(e) => setRoles(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>{msg("officials.add")}</button>
            {rolePreset.crew.length > 1 && (
              <span className="basis-full text-[11px] text-slate-400">
                {msg("officials.crew", { crew: rolePreset.crew.join(", ") })}
              </span>
            )}
          </form>
        )}
      </div>

      {/* auto assign */}
      {canEdit && (
        <div className="card space-y-3 p-4">
          <h3 className="text-sm font-semibold text-slate-900">{msg("officials.autoAssign")}</h3>
          <div className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={blockStay} onChange={(e) => setBlockStay(e.target.checked)} />
              {msg("officials.blockStay")}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={poolLock} onChange={(e) => setPoolLock(e.target.checked)} />
              {msg("officials.poolLock")}
            </label>
            <label className="flex items-center gap-1.5">
              {msg("officials.fairness")}
              <select
                className="input"
                value={fairness}
                onChange={(e) => setFairness(e.target.value as "tournament" | "per_day")}
              >
                <option value="tournament">{msg("officials.fairnessTournament")}</option>
                <option value="per_day">{msg("officials.fairnessPerDay")}</option>
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const p = await apiV1<Proposal>(`/api/v1/divisions/${divisionId}/officials/auto`, {
                    method: "POST",
                    json: {
                      policy: { roles: ["referee"], blockStay, poolLock, fairness },
                    },
                  });
                  setProposal(p);
                }, false)
              }
            >
              {msg("officials.propose")}
            </button>
            {proposal && proposal.assignments.length > 0 && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || proposal.conflicts.some((c) => c.severity === "block")}
                onClick={() =>
                  void run(async () => {
                    await apiV1(`/api/v1/divisions/${divisionId}/officials/apply`, {
                      method: "POST",
                      json: {
                        assignments: proposal.assignments
                          .filter((a) => !a.locked)
                          .map((a) => ({
                            fixture_id: a.fixtureId,
                            official_id: a.officialId,
                            role_key: a.roleKey,
                          })),
                      },
                    });
                    setProposal(null);
                  })
                }
              >
                {msg("officials.apply", { n: proposal.assignments.length })}
              </button>
            )}
          </div>
          {proposal && proposal.assignments.length === 0 && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-700">{msg("officials.nothing")}</p>
          )}
          {proposal && proposal.conflicts.length > 0 && (
            <ul className="space-y-1">
              {proposal.conflicts.map((c, i) => (
                <li
                  key={i}
                  className={`rounded-md px-3 py-1.5 text-sm ${
                    c.severity === "block" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {c.kind}
                  {c.fixtureId ? ` — ${c.fixtureId.slice(0, 8)}` : ""} {c.detail ?? ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* phased sourcing (17 Jun / 3 Jun) */}
      {canEdit && stages.length > 0 && (
        <div className="card space-y-3 p-4">
          <h3 className="text-sm font-semibold text-slate-900">{msg("officials.source")}</h3>
          <p className="text-xs text-slate-500">{msg("officials.sourceHint")}</p>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              {msg("officials.fromStage")}
              <select className="input" value={sourceStage} onChange={(e) => setSourceStage(e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              {msg("officials.rank")}
              <input
                type="number"
                min={1}
                className="input w-20"
                value={sourceRank}
                onChange={(e) => setSourceRank(Number(e.target.value))}
              />
            </label>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={busy || !sourceStage}
              onClick={() =>
                void run(async () => {
                  const s = await apiV1<Sourced>(`/api/v1/stages/${sourceStage}/officials/source`, {
                    method: "POST",
                    json: { sources: [{ kind: "rank", fromStage: sourceStage, take: [{ rank: sourceRank }] }] },
                  });
                  setSourced(s);
                }, false)
              }
            >
              {msg("officials.resolve")}
            </button>
          </div>
          {sourced && (
            <ul className="space-y-1 text-sm">
              {sourced.resolved.map((r) => (
                <li key={r.entrant_id} className="flex items-center gap-2">
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
                    {r.display_name}
                  </span>
                  {r.official_id ? (
                    <span className="text-xs text-slate-400">{msg("officials.alreadyOfficial")}</span>
                  ) : (
                    <button
                      type="button"
                      className="text-xs text-purple-600 hover:underline"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          apiV1("/api/v1/officials", {
                            method: "POST",
                            json: {
                              display_name: `${r.display_name} (ref)`,
                              entrant_id: r.entrant_id,
                              role_keys: ["referee"],
                            },
                          }),
                        )
                      }
                    >
                      {msg("officials.addTeamRef")}
                    </button>
                  )}
                </li>
              ))}
              {sourced.pending.map((p, i) => (
                <li key={`p${i}`} className="rounded-md bg-amber-50 px-3 py-1.5 text-amber-700">
                  {msg("officials.pending", { reason: p.reason })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* per-fixture manual assignment */}
      <div className="card scroll-x scroll-x-fade">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">{msg("officials.colFixture")}</th>
              <th className="px-4 py-2 text-left">{msg("officials.colKickoff")}</th>
              <th className="px-4 py-2 text-left">{msg("officials.colOfficials")}</th>
              {canEdit && <th className="px-4 py-2 text-right">{msg("officials.colAssign")}</th>}
            </tr>
          </thead>
          <tbody>
            {fixtures.map((f) => (
              <tr key={f.id} className="border-t border-slate-100 align-top">
                <td className="px-4 py-2 text-sm text-slate-700">{f.label}</td>
                <td className="px-4 py-2 text-sm text-slate-500">
                  {f.scheduled_at
                    ? new Date(f.scheduled_at).toLocaleString(locale, {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </td>
                <td className="px-4 py-2">
                  {f.officials.length === 0 ? (
                    <span className="text-sm text-slate-400">—</span>
                  ) : (
                    <ul className="flex flex-wrap gap-1">
                      {f.officials.map((o, i) => (
                        <li key={i} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                          {o.name} <span className="text-slate-400">{o.role}</span>
                          {o.locked && <span aria-label={msg("officials.locked")} title={msg("officials.locked")}> 🔒</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                {canEdit && (
                  <td className="px-4 py-2 text-right">
                    <select
                      className="input"
                      aria-label={msg("officials.assignAria", { label: f.label })}
                      value={f.officials[0]?.official_id ?? ""}
                      disabled={busy}
                      onChange={(e) => {
                        const officialId = e.target.value;
                        void run(() =>
                          apiV1(`/api/v1/fixtures/${f.id}/officials`, {
                            method: "PATCH",
                            json: {
                              set: officialId
                                ? [{ official_id: officialId, role_key: "referee", locked: false }]
                                : [],
                            },
                          }),
                        );
                      }}
                    >
                      <option value="">{msg("officials.none")}</option>
                      {officials.map((o) => (
                        <option key={o.id} value={o.id}>{officialName(o.id)}</option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
