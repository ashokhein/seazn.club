"use client";

// Officials console (Jul3/02 §5): palette + auto/apply proposal feeding the
// schedule, per-fixture manual assign with lock, phased sourcing affordance,
// hide-names toggle. Keyboard-accessible; conflict badges mirror doc 12 §2
// block/warn.
// v11.1 follow-up: roster management (add / invite / bulk-invite) moved to
// the org-wide Directory → Officials tab (officials-directory-panel.tsx) —
// this panel now shows a compact read-only roster strip that links there.
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "@/components/ui/console-link";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg, useLocale } from "@/components/i18n/dict-provider";
import { OfficialAvatar } from "@/components/v2/officials-shared";
import { fmtTime, fmtZoneAbbrev } from "@/lib/format";
import { MarkControl } from "@/components/officials/mark-tiles";
import { ReportDrawer, type MatchReport } from "@/components/officials/report-drawer";

type FixtureReportLite = MatchReport & { officialName: string };

interface Official {
  id: string;
  display_name: string;
  role_keys: string[];
  entrant_id: string | null;
  max_per_day: number | null;
  /** v11 claim-rail state */
  email: string | null;
  claimed: boolean;
  invite_pending: boolean;
}
interface FixtureLite {
  id: string;
  label: string;
  scheduled_at: string | Date | null;
  status: string;
  officials: {
    official_id: string;
    name: string;
    role: string;
    locked: boolean;
    /** v11: pending | accepted | declined (older cache rows omit it). */
    response?: string;
    decline_reason?: string | null;
  }[];
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

const OFFICIALS_TOP = new Set(["scheduled"]);
/** Assignment view: matches still needing officials first (scheduled, by
 *  kickoff), then in_play + decided (finalized/cancelled) at the bottom. */
export function sortFixturesForOfficials<T extends { status: string; scheduled_at: string | Date | null }>(
  fixtures: T[],
): T[] {
  // scheduled_at crosses the RSC boundary as a Date (not an ISO string), so
  // compare on epoch ms — never string methods. Unscheduled sorts last.
  const key = (f: T) => (f.scheduled_at == null ? Infinity : new Date(f.scheduled_at).getTime());
  const byTime = (a: T, b: T) => key(a) - key(b);
  const top = fixtures.filter((f) => OFFICIALS_TOP.has(f.status)).sort(byTime);
  const bottom = fixtures.filter((f) => !OFFICIALS_TOP.has(f.status)).sort(byTime);
  return [...top, ...bottom];
}

export function OfficialsPanel({
  divisionId,
  officials,
  fixtures,
  stages,
  hideNames,
  canEdit,
  blackouts = [],
  busyElsewhere = [],
  venueTz = "UTC",
  marksEnabled = false,
  foIdByAssignment = {},
  marksByFoId = {},
  reportsByFixture = {},
}: {
  divisionId: string;
  officials: Official[];
  fixtures: FixtureLite[];
  stages: StageLite[];
  hideNames: boolean;
  canEdit: boolean;
  /** v11: blackout dates per official — warns before assigning onto one. */
  blackouts?: { official_id: string; date: string }[];
  /** v11.1: other-org booked times for MY officials — timestamp only, never
   *  which org/competition/fixture (derived read, privacy by design). */
  busyElsewhere?: { official_id: string; scheduled_at: string }[];
  /** Venue zone for matching a fixture's date against blackout dates. */
  venueTz?: string;
  /** SPEC-3: Pro `officials.marks` — gates the mark tiles (community sees the
   *  upgrade gate instead). */
  marksEnabled?: boolean;
  /** `${fixture_id}:${official_id}:${role_key}` → fixture_officials surrogate id
   *  (the cache jsonb doesn't carry it). */
  foIdByAssignment?: Record<string, string>;
  /** fixture_official_id → existing mark (prefill the tiles). */
  marksByFoId?: Record<string, number>;
  /** fixture_id → submitted reports (drawer). */
  reportsByFixture?: Record<string, FixtureReportLite[]>;
}) {
  const msg = useMsg();
  const locale = useLocale();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [blockStay, setBlockStay] = useState(true);
  const [poolLock, setPoolLock] = useState(false);
  const [fairness, setFairness] = useState<"tournament" | "per_day">("tournament");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [sourceStage, setSourceStage] = useState(stages[0]?.id ?? "");
  const [sourceRank, setSourceRank] = useState(4);
  const [sourced, setSourced] = useState<Sourced | null>(null);

  const officialName = (id: string) =>
    officials.find((o) => o.id === id)?.display_name ?? id;

  // Blackout lookup (v11 warn-before-assign): official → set of unavailable
  // dates, matched against the fixture's date in the venue zone.
  const blackoutsByOfficial = new Map<string, Set<string>>();
  for (const b of blackouts) {
    const set = blackoutsByOfficial.get(b.official_id) ?? new Set<string>();
    set.add(b.date);
    blackoutsByOfficial.set(b.official_id, set);
  }
  const fixtureDate = (iso: string | Date | null): string | null => {
    if (!iso) return null;
    try {
      return new Date(iso).toLocaleDateString("en-CA", { timeZone: venueTz || "UTC" });
    } catch {
      return (typeof iso === "string" ? iso : iso.toISOString()).slice(0, 10);
    }
  };
  const unavailableFor = (officialId: string, scheduledAt: string | Date | null): boolean => {
    const d = fixtureDate(scheduledAt);
    return d !== null && (blackoutsByOfficial.get(officialId)?.has(d) ?? false);
  };

  // Busy-elsewhere lookup (v11.1 warn-before-assign): official → other-org
  // booked timestamps, matched against the fixture's date in the venue zone.
  // Timestamp only — never which org/competition/fixture (derived read).
  const busyByOfficial = new Map<string, string[]>();
  for (const b of busyElsewhere) {
    const list = busyByOfficial.get(b.official_id) ?? [];
    list.push(b.scheduled_at);
    busyByOfficial.set(b.official_id, list);
  }
  const busyTimeFor = (officialId: string, scheduledAt: string | Date | null): string | null => {
    const d = fixtureDate(scheduledAt);
    if (d === null) return null;
    const match = busyByOfficial.get(officialId)?.find((at) => fixtureDate(at) === d);
    if (!match) return null;
    return `${fmtTime(venueTz, match)} ${fmtZoneAbbrev(venueTz, match)}`;
  };

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

      {/* compact read-only roster strip (v11.1): full roster management —
          add / invite / bulk-invite — moved to Directory → Officials. */}
      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
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
          <ul className="flex flex-wrap gap-2">
            {officials.map((o) => (
              <li
                key={o.id}
                className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-3"
              >
                <OfficialAvatar name={o.display_name} size="sm" />
                <span className="text-xs text-slate-700">{o.display_name}</span>
                {o.claimed ? (
                  <span className="rounded bg-lime-100 px-1.5 py-0.5 text-[10px] text-lime-700">
                    {msg("officials.linked")}
                  </span>
                ) : o.invite_pending ? (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">
                    {msg("officials.invited")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <Link
            href="/directory?tab=officials"
            prefetch={false}
            className="inline-block text-xs font-medium text-purple-600 hover:underline"
          >
            {msg("officials.manageInDirectory")} →
          </Link>
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
            {sortFixturesForOfficials(fixtures).map((f) => (
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
                      {f.officials.map((o, i) => {
                        // v11 response flag: a decline is the organiser's cue
                        // for a manual re-pick — nothing is reassigned for them.
                        const declined = o.response === "declined";
                        const pending = o.response === "pending";
                        return (
                          <li
                            key={i}
                            title={
                              declined && o.decline_reason
                                ? msg("officials.declineReason", { reason: o.decline_reason })
                                : declined
                                  ? msg("officials.respDeclined")
                                  : pending
                                    ? msg("officials.respPending")
                                    : o.response === "accepted"
                                      ? msg("officials.respAccepted")
                                      : undefined
                            }
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              declined
                                ? "bg-red-50 text-red-700 ring-1 ring-red-200"
                                : pending
                                  ? "bg-amber-50 text-amber-800"
                                  : "bg-slate-100 text-slate-700"
                            }`}
                          >
                            {declined ? "✗ " : pending ? "· " : o.response === "accepted" ? "✓ " : ""}
                            {o.name} <span className={declined ? "text-red-400" : "text-slate-400"}>{o.role}</span>
                            {o.locked && <span aria-label={msg("officials.locked")} title={msg("officials.locked")}> 🔒</span>}
                            {unavailableFor(o.official_id, f.scheduled_at) && (
                              <span
                                className="ml-1 text-amber-600"
                                title={msg("officials.unavailableOn")}
                              >
                                ⚠
                              </span>
                            )}
                            {(() => {
                              const busyTime = busyTimeFor(o.official_id, f.scheduled_at);
                              return busyTime ? (
                                <span
                                  className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700 ring-1 ring-amber-200"
                                  title={msg("officials.bookedElsewhereTitle")}
                                >
                                  {msg("officials.bookedElsewhere", { time: busyTime })}
                                </span>
                              ) : null;
                            })()}
                          </li>
                        );
                      })}
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
                      {officials.map((o) => {
                        const busyTime = busyTimeFor(o.id, f.scheduled_at);
                        return (
                          <option key={o.id} value={o.id}>
                            {officialName(o.id)}
                            {unavailableFor(o.id, f.scheduled_at)
                              ? ` — ${msg("officials.unavailableSuffix")}`
                              : busyTime
                                ? ` — ${msg("officials.bookedElsewhereSuffix", { time: busyTime })}`
                                : ""}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* SPEC-3: rate accepted officials once a fixture is decided; view any
          submitted match report. A dedicated section (not table cells) so the
          scoreboard-digit tiles breathe on mobile. */}
      <RateOfficials
        fixtures={fixtures}
        marksEnabled={marksEnabled}
        foIdByAssignment={foIdByAssignment}
        marksByFoId={marksByFoId}
        reportsByFixture={reportsByFixture}
        venueTz={venueTz}
      />
    </section>
  );
}

const RATEABLE_STATUS = new Set(["decided", "finalized"]);

/** The "Rate officials" section: for every decided fixture with an accepted
 *  official, the five-digit mark tiles (Pro) or the upgrade gate (community),
 *  plus a chip opening the read-only drawer for any submitted report. */
function RateOfficials({
  fixtures,
  marksEnabled,
  foIdByAssignment,
  marksByFoId,
  reportsByFixture,
  venueTz,
}: {
  fixtures: FixtureLite[];
  marksEnabled: boolean;
  foIdByAssignment: Record<string, string>;
  marksByFoId: Record<string, number>;
  reportsByFixture: Record<string, FixtureReportLite[]>;
  venueTz: string;
}) {
  const msg = useMsg();
  const rateable = fixtures.filter(
    (f) => RATEABLE_STATUS.has(f.status) && f.officials.some((o) => o.response === "accepted"),
  );
  if (rateable.length === 0) return null;
  return (
    <div className="card space-y-4 p-4" data-testid="rate-officials">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{msg("officials.rate.heading")}</h3>
        {!marksEnabled && <UpgradeGate feature="officials.marks" compact />}
      </div>
      <ul className="space-y-4">
        {rateable.map((f) => (
          <li key={f.id} className="space-y-2 border-t border-slate-100 pt-3 first:border-0 first:pt-0">
            <p className="text-sm font-medium text-slate-700">{f.label}</p>
            <ul className="space-y-3">
              {f.officials
                .filter((o) => o.response === "accepted")
                .map((o, i) => {
                  const foId = foIdByAssignment[`${f.id}:${o.official_id}:${o.role}`];
                  return (
                    <li key={i} className="flex flex-col gap-1.5">
                      <span className="text-xs text-slate-500">
                        {o.name} <span className="text-slate-400">{o.role}</span>
                      </span>
                      {foId && marksEnabled ? (
                        <MarkControl fixtureOfficialId={foId} initialMark={marksByFoId[foId] ?? null} />
                      ) : !marksEnabled ? (
                        <span className="text-xs text-slate-400">{msg("officials.rate.locked")}</span>
                      ) : null}
                    </li>
                  );
                })}
            </ul>
            {(reportsByFixture[f.id] ?? []).map((r) => (
              <ReportChip key={r.id} report={r} venueTz={venueTz} />
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A submitted-report chip that toggles the read-only console drawer. */
function ReportChip({ report, venueTz }: { report: FixtureReportLite; venueTz: string }) {
  const msg = useMsg();
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-slate-100 px-3 text-xs font-medium text-slate-700 hover:bg-slate-200"
      >
        {msg("officials.rate.viewReport", { name: report.officialName })}
      </button>
      {open && (
        <div className="rounded-lg border border-slate-200 p-3">
          <ReportDrawer report={report} officialName={report.officialName} venueTz={venueTz} />
        </div>
      )}
    </div>
  );
}
