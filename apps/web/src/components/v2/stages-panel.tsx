"use client";

// Fixture console per stage (PROMPT-15 task 1, rebuilt per v3/04 §3): rounds
// grouped with date ranges, competition-timezone rendering, pinned
// unscheduled section with an auto-schedule CTA, "Now playing" strip, inline
// reschedule with undo, bye/void ghost rows, sticky round headers on mobile,
// print via the DocModel timetable export. Scoring lives on the fixture page.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { routes } from "@/lib/routes";
import { ClientDateRange, ClientTime } from "@/components/client-time";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { TipCallout } from "@/components/ui/tip";
import { msg } from "@/lib/messages";

interface StageRow {
  id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  qualification: Record<string, unknown> | null;
  status: string;
}
interface FixtureRow {
  id: string;
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | null;
  venue: string | null;
  court_label: string | null;
  status: string;
  outcome: unknown;
}

interface Props {
  divisionId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  stages: StageRow[];
  fixtures: FixtureRow[];
  entrantNames: Record<string, string>;
  canEdit: boolean;
  /** Competition timezone (schedule settings) — every time renders in it. */
  tz: string;
  /** Print goes through the Jul3/06 timetable export (Pro `exports` gate). */
  canExport: boolean;
}

const FIXTURE_STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-600",
  in_play: "bg-amber-100 text-amber-700",
  decided: "bg-sky-100 text-sky-700",
  finalized: "bg-emerald-100 text-emerald-700",
  abandoned: "bg-slate-100 text-slate-400",
  forfeited: "bg-red-50 text-red-500",
  cancelled: "bg-slate-100 text-slate-400",
};

export function StagesPanel({ divisionId, orgSlug, compSlug, divSlug, stages, fixtures, entrantNames, canEdit, tz, canExport }: Props) {
  const confirmDialog = useConfirm();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // stage id in flight
  const [notice, setNotice] = useState<string | null>(null);
  // Set after an inline reschedule lands: the notice grows an Undo button
  // that steps the division history back one event (Jul3/03).
  const [undoable, setUndoable] = useState(false);

  async function undoLast() {
    setError(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/undo`, { method: "POST", json: {} });
      setNotice("Change undone.");
      setUndoable(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Undo failed");
    }
  }

  // "Auto-schedule remaining" (v3/04 §3 item 3) — the board's propose+apply
  // pair for one stage, launched from the pinned unscheduled section.
  async function autoScheduleStage(stageId: string) {
    setError(null);
    setNotice(null);
    setBusy(stageId);
    try {
      const out = await apiV1<{
        assignments: { fixture_id: string; scheduled_at: string; court_label: string }[];
      }>(`/api/v1/stages/${stageId}/schedule/auto`, { method: "POST", json: { only_unlocked: true } });
      if (out.assignments.length === 0) {
        setNotice("Nothing to schedule — no free slots or nothing unscheduled.");
        return;
      }
      const applied = await apiV1<{ applied: number }>(`/api/v1/stages/${stageId}/schedule/apply`, {
        method: "POST",
        json: { assignments: out.assignments, source: "auto" },
      });
      setNotice(`Placed ${applied.applied} fixture(s).`);
      setUndoable(true);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(null);
    }
  }

  async function act(stageId: string, action: "generate" | "complete" | "delete") {
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setBusy(stageId);
    try {
      if (action === "delete") {
        await apiV1(`/api/v1/stages/${stageId}`, { method: "DELETE" });
        setNotice("Stage deleted.");
      } else if (action === "generate") {
        const out = await apiV1<{ created: number; existing: number }>(
          `/api/v1/stages/${stageId}/generate`,
          { method: "POST", json: {} },
        );
        setNotice(
          out.created > 0
            ? `Generated ${out.created} fixture(s) (${out.existing} already existed).`
            : "Nothing new to generate — fixtures are up to date.",
        );
      } else {
        const out = await apiV1<{
          completed: boolean;
          qualified?: { entrants: string[] };
          next_stage_fixtures?: number;
          division_completed?: boolean;
        }>(`/api/v1/stages/${stageId}/complete`, { method: "POST", json: {} });
        setNotice(
          !out.completed
            ? "Stage is not ready to complete (undecided fixtures remain)."
            : out.division_completed
              ? "Stage completed — that was the last stage, the division is finished. 🏆"
              : out.next_stage_fixtures !== undefined
                ? `Stage completed — top ${out.qualified?.entrants.length ?? ""} advance; ${out.next_stage_fixtures} fixture(s) generated for the next stage.`
                : "Stage completed.",
        );
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(null);
    }
  }

  if (stages.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        This division has no stages yet — recreate it with a format, or define
        stages via the API.
      </p>
    );
  }

  const nowPlaying = fixtures.filter((f) => f.status === "in_play");

  return (
    <div className="space-y-6">
      {canEdit && <TipCallout id="division.start-locks" />}
      {notice && (
        <p className="flex items-center gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
          {undoable && (
            <button
              type="button"
              onClick={() => void undoLast()}
              className="font-semibold underline hover:no-underline"
            >
              {msg("schedule.undo")}
            </button>
          )}
        </p>
      )}
      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {/* Timezone honesty (v3/04 §3 item 2) + print (item 8). */}
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-xs text-slate-500" data-testid="tz-caption">
          {msg("schedule.tz.caption", { tz })}
        </p>
        <div className="flex-1" />
        {canExport && (
          <a
            className="btn btn-ghost text-xs"
            href={`/api/v1/divisions/${divisionId}/exports/timetable?format=pdf`}
          >
            Print schedule
          </a>
        )}
      </div>

      {/* "Now playing" strip (item 4): in-play matches float above the rounds. */}
      {nowPlaying.length > 0 && (
        <section
          className="rounded-xl border border-amber-200 bg-amber-50/70 p-3"
          aria-label={msg("schedule.nowPlaying")}
        >
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-amber-800 uppercase">
            {msg("schedule.nowPlaying")}
          </h3>
          <ul className="flex flex-wrap gap-2">
            {nowPlaying.map((f) => (
              <li key={f.id}>
                <Link
                  href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 hover:border-amber-400"
                >
                  <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                  {f.home_entrant_id ? (entrantNames[f.home_entrant_id] ?? "?") : "TBD"} vs{" "}
                  {f.away_entrant_id ? (entrantNames[f.away_entrant_id] ?? "?") : "TBD"}
                  {f.court_label ? <span className="text-slate-500">· {f.court_label}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Active work first: completed stages sink to the bottom, so once the
          league wraps up the semis/final card is what the organiser lands on. */}
      {[...stages]
        .sort(
          (a, b) =>
            (a.status === "complete" ? 1 : 0) - (b.status === "complete" ? 1 : 0) ||
            a.seq - b.seq,
        )
        .map((stage) => {
        const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
        const rounds = [...new Set(stageFixtures.map((f) => f.round_no))].sort((a, b) => a - b);
        // Pinned unscheduled section (v3/04 §3 item 3): timetable-less rows
        // come out of the round lists; byes stay in place as ghosts.
        const unscheduled = stageFixtures.filter(
          (f) => f.scheduled_at === null && f.status === "scheduled" && !isBye(f),
        );
        const roundDates = (round: number): { from: string | null; to: string | null } => {
          const times = stageFixtures
            .filter((f) => f.round_no === round && f.scheduled_at !== null)
            .map((f) => f.scheduled_at as string)
            .sort();
          return { from: times[0] ?? null, to: times[times.length - 1] ?? null };
        };
        // Mirrors the server guard: last stage only, nothing played yet.
        const deletable =
          stage.seq === Math.max(...stages.map((s) => s.seq)) &&
          !stageFixtures.some((f) => ["in_play", "decided", "finalized"].includes(f.status));
        const maxRound = rounds[rounds.length - 1] ?? 0;
        // Bracket stages: one card per named round (Quarter-finals, Semi-finals,
        // Final / Rung N) instead of one long card with anonymous round breaks.
        const splitRounds = BRACKET_KINDS.has(stage.kind) && rounds.length > 0;
        return (
          <div key={stage.id} className="space-y-6">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-800">
                {stage.seq}. {stage.name}
              </h3>
              <span className="chip">{stage.kind}</span>
              <span className={`badge ${stageStatusStyle(stage.status)}`}>{stage.status}</span>
              <div className="flex-1" />
              {canEdit && stage.status !== "complete" && (
                <>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => act(stage.id, "generate")}
                    className="btn btn-ghost px-3 py-1.5 text-xs"
                  >
                    {busy === stage.id ? "Working…" : stage.kind === "swiss" ? "Pair next round" : "Generate fixtures"}
                  </button>
                  {stageFixtures.length > 0 && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => act(stage.id, "complete")}
                      className="btn btn-primary px-3 py-1.5 text-xs"
                    >
                      Complete stage
                    </button>
                  )}
                </>
              )}
              {canEdit && deletable && stages.length > 1 && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    const ok = await confirmDialog({
                      title: msg("confirm.deleteStage.title"),
                      body: msg("confirm.deleteStage.body", { name: stage.name }),
                      confirmLabel: msg("confirm.deleteStage.label"),
                      tone: "danger",
                    });
                    if (ok) void act(stage.id, "delete");
                  }}
                  className="btn btn-danger px-3 py-1.5 text-xs"
                >
                  Delete
                </button>
              )}
            </header>

            {/* Pinned unscheduled section (item 3) — count + auto CTA. */}
            {unscheduled.length > 0 && (
              <div className="border-b border-dashed border-slate-200 bg-slate-50/60 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold text-slate-700">
                    {msg("schedule.unscheduled.title")}
                    <span className="ml-1.5 rounded-full bg-slate-200 px-1.5 text-[11px] font-medium text-slate-700">
                      {unscheduled.length}
                    </span>
                  </p>
                  {canEdit && stage.status !== "complete" && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void autoScheduleStage(stage.id)}
                      className="btn btn-primary px-3 py-1 text-xs"
                    >
                      {busy === stage.id ? "Working…" : msg("schedule.unscheduled.cta")}
                    </button>
                  )}
                </div>
                <ul className="mt-2 divide-y divide-slate-100">
                  {unscheduled.map((f) => (
                    <FixtureLine
                      key={f.id}
                      fixture={f}
                      href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                      entrantNames={entrantNames}
                      canEdit={canEdit}
                      tz={tz}
                      onRescheduled={() => {
                        setNotice(msg("schedule.rescheduled"));
                        setUndoable(true);
                      }}
                    />
                  ))}
                </ul>
              </div>
            )}

            {stageFixtures.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-500">
                No fixtures yet{canEdit ? " — generate them when entrants are registered." : "."}
              </p>
            ) : splitRounds ? null : (
              <div className="divide-y divide-slate-100">
                {rounds.map((round) => {
                  const dates = roundDates(round);
                  return (
                  <div key={round}>
                    {/* Sticky round header (items 1 + 7): label + date range. */}
                    <p className="sticky top-0 z-10 flex items-baseline gap-2 bg-slate-50 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
                      Round {round}
                      {dates.from && (
                        <span className="normal-case text-slate-500">
                          <ClientDateRange from={dates.from} to={dates.to} tz={tz} />
                        </span>
                      )}
                    </p>
                    <ul className="divide-y divide-slate-50">
                      {stageFixtures
                        .filter((f) => f.round_no === round && (f.scheduled_at !== null || isBye(f) || f.status !== "scheduled"))
                        .map((f) => (
                          <FixtureLine
                            key={f.id}
                            fixture={f}
                            href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                            entrantNames={entrantNames}
                            canEdit={canEdit}
                            tz={tz}
                            onRescheduled={() => {
                              setNotice(msg("schedule.rescheduled"));
                              setUndoable(true);
                            }}
                          />
                        ))}
                    </ul>
                  </div>
                  );
                })}
              </div>
            )}
          </section>

          {splitRounds &&
            rounds.map((round) => {
              const dates = roundDates(round);
              return (
              <section key={round} className="card overflow-hidden">
                <header className="sticky top-0 z-10 border-b border-slate-100 bg-slate-50 px-4 py-2">
                  <h4 className="flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
                    {stage.name} — {bracketRoundLabel(stage.kind, round, maxRound)}
                    {dates.from && (
                      <span className="normal-case text-slate-500">
                        <ClientDateRange from={dates.from} to={dates.to} tz={tz} />
                      </span>
                    )}
                  </h4>
                </header>
                <ul className="divide-y divide-slate-50">
                  {stageFixtures
                    .filter((f) => f.round_no === round && (f.scheduled_at !== null || isBye(f) || f.status !== "scheduled"))
                    .map((f) => (
                      <FixtureLine
                        key={f.id}
                        fixture={f}
                        href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                        entrantNames={entrantNames}
                        canEdit={canEdit}
                        tz={tz}
                        onRescheduled={() => {
                          setNotice(msg("schedule.rescheduled"));
                          setUndoable(true);
                        }}
                      />
                    ))}
                </ul>
              </section>
              );
            })}
          </div>
        );
      })}

      {canEdit && (
        <AddStageForm
          divisionId={divisionId}
          nextSeq={Math.max(0, ...stages.map((s) => s.seq)) + 1}
          onDone={(msg) => {
            setNotice(msg);
            router.refresh();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

// Follow-up stage (e.g. finals after a league). Qualification resolves from
// the previous stage's final table; if that stage is already complete the
// server seeds + generates on the spot.
const ADD_KINDS = [
  { key: "knockout", label: "Knockout" },
  { key: "stepladder", label: "Stepladder" },
  { key: "double_elim", label: "Double elimination" },
] as const;

function AddStageForm({
  divisionId,
  nextSeq,
  onDone,
  onError,
}: {
  divisionId: string;
  nextSeq: number;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Finals");
  const [kind, setKind] = useState<string>("knockout");
  const [topN, setTopN] = useState(4);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    onError("");
    try {
      const stage = await apiV1<{ id: string }>(`/api/v1/divisions/${divisionId}/stages`, {
        method: "POST",
        json: {
          seq: nextSeq,
          kind,
          name: name.trim() || "Finals",
          config: {},
          qualification: { topN },
        },
      });
      try {
        const gen = await apiV1<{ created: number }>(`/api/v1/stages/${stage.id}/generate`, {
          method: "POST",
          json: {},
        });
        onDone(`Stage added — ${gen.created} fixture(s) generated for the top ${topN}.`);
      } catch (err) {
        // Previous stage not complete yet — the stage exists; completion will
        // seed + generate it.
        if (err instanceof ApiV1Error && err.code === "STAGE_NOT_READY") {
          onDone("Stage added — fixtures will generate when the previous stage completes.");
        } else {
          throw err;
        }
      }
      setOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost text-xs">
        + Add stage
      </button>
    );
  }

  return (
    <section className="card flex flex-wrap items-end gap-3 p-4">
      <label className="block">
        <span className="label">Stage name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          className="input w-40"
        />
      </label>
      <label className="block">
        <span className="label">Format</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="select">
          {ADD_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="label">Qualify from table</span>
        <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} className="select">
          {[2, 3, 4, 6, 8].map((n) => (
            <option key={n} value={n}>
              Top {n}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={add} className="btn btn-primary text-xs">
        {busy ? "Adding…" : "Add stage"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost text-xs">
        Cancel
      </button>
    </section>
  );
}

const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder"]);

/** A bye: one side empty with an auto-advance award outcome (v3/04 §3 item 6). */
function isBye(f: FixtureRow): boolean {
  const o = f.outcome as { kind?: string } | null;
  return o?.kind === "award" && (f.home_entrant_id === null || f.away_entrant_id === null);
}

/** Voided fixtures render struck through with the reason (item 6). */
const VOID_STATUSES = new Set(["cancelled", "abandoned", "forfeited"]);

// Named bracket rounds, by distance from the last round. Double-elim round
// numbers encode WB/LB/GF lanes, so plain "Round N" stays honest there.
function bracketRoundLabel(kind: string, roundNo: number, maxRound: number): string {
  if (kind === "stepladder") return `Rung ${roundNo}`;
  if (kind === "knockout") {
    const fromEnd = maxRound - roundNo;
    if (fromEnd === 0) return "Final";
    if (fromEnd === 1) return "Semi-finals";
    if (fromEnd === 2) return "Quarter-finals";
  }
  return `Round ${roundNo}`;
}

function stageStatusStyle(status: string): string {
  if (status === "active") return "bg-amber-100 text-amber-700";
  if (status === "complete") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-600";
}

function outcomeText(outcome: unknown, entrantNames: Record<string, string>): string | null {
  const o = outcome as { kind?: string; winner?: string } | null;
  if (!o?.kind) return null;
  switch (o.kind) {
    case "win":
    case "award":
      return `${entrantNames[o.winner ?? ""] ?? "?"} won${o.kind === "award" ? " (w/o)" : ""}`;
    case "draw":
      return "Draw";
    case "tie":
      return "Tie";
    case "no_result":
      return "No result";
    default:
      return null;
  }
}

function FixtureLine({
  fixture,
  href,
  entrantNames,
  canEdit,
  tz,
  onRescheduled,
}: {
  fixture: FixtureRow;
  href: string;
  entrantNames: Record<string, string>;
  canEdit: boolean;
  tz?: string;
  /** Fired after a schedule PATCH lands — the panel offers Undo (item 5). */
  onRescheduled?: () => void;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(
    fixture.scheduled_at ? toLocalInput(fixture.scheduled_at) : "",
  );
  const [venue, setVenue] = useState(fixture.venue ?? "");
  const [court, setCourt] = useState(fixture.court_label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const home = fixture.home_entrant_id ? (entrantNames[fixture.home_entrant_id] ?? "?") : "TBD";
  const away = fixture.away_entrant_id ? (entrantNames[fixture.away_entrant_id] ?? "?") : "TBD";
  const decided = outcomeText(fixture.outcome, entrantNames);

  // Bye ghost row (item 6): structural, not schedulable, no actions.
  if (isBye(fixture)) {
    const who = fixture.home_entrant_id ?? fixture.away_entrant_id;
    return (
      <li className="px-4 py-2 text-sm text-slate-500 italic">
        R{fixture.round_no} · {msg("schedule.bye", { name: entrantNames[who ?? ""] ?? "?" })}
      </li>
    );
  }

  async function patchSchedule(json: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}`, { method: "PATCH", json });
      setEditing(false);
      router.refresh();
      onRescheduled?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const saveSchedule = () =>
    patchSchedule({
      scheduled_at: when ? new Date(when).toISOString() : null,
      venue: venue.trim() || null,
      court_label: court.trim() || null,
    });

  const unschedule = () => {
    setWhen("");
    void patchSchedule({ scheduled_at: null });
  };

  // Play state only matters once a match is under way / done; before that a
  // plain "scheduled" DB status is noise next to the timetable chip.
  const played = ["in_play", "decided", "finalized", "cancelled"].includes(fixture.status);
  const timed = !!fixture.scheduled_at;

  const voided = VOID_STATUSES.has(fixture.status);

  return (
    <li className="px-4 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={href}
          className={`min-w-0 flex-1 text-sm hover:text-purple-700 ${
            voided ? "text-slate-500 line-through" : "text-slate-800"
          }`}
        >
          <span className="font-medium">{home}</span>
          <span className="mx-1.5 text-slate-400">vs</span>
          <span className="font-medium">{away}</span>
          {decided && !voided && <span className="ml-2 text-xs text-slate-500 no-underline">{decided}</span>}
        </Link>
        {/* Timetable chip — reflects whether the match has a kick-off time. */}
        <span
          className={`badge ${timed ? "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200" : "bg-slate-100 text-slate-500"}`}
          title={timed ? "This match has a kick-off time" : "No kick-off time yet"}
        >
          {timed ? (
            <>
              Scheduled · <ClientTime value={fixture.scheduled_at} mode="datetime" tz={tz} />
            </>
          ) : (
            "Unscheduled"
          )}
          {fixture.court_label ? ` · ${fixture.court_label}` : fixture.venue ? ` · ${fixture.venue}` : ""}
        </span>
        {/* Play state only once it's under way / done. */}
        {played && (
          <span className={`badge ${FIXTURE_STATUS_STYLE[fixture.status] ?? ""}`}>
            {fixture.status.replace("_", " ")}
          </span>
        )}
        {/* Scoring pad. */}
        <Link href={href} className="btn btn-ghost px-3 py-1 text-xs">
          {decided ? "View" : fixture.status === "in_play" ? "Score ●" : "Score"}
        </Link>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="btn btn-ghost px-3 py-1 text-xs"
          >
            {editing ? "Close" : timed ? "Edit time" : "Schedule"}
          </button>
        )}
        {canEdit && timed && !editing && (
          <button
            type="button"
            disabled={busy}
            onClick={unschedule}
            className="text-xs text-slate-500 hover:text-red-600 hover:underline"
          >
            Unschedule
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">When</span>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="input px-2 py-1 text-xs"
            />
          </label>
          <label className="block">
            <span className="label">Venue</span>
            <input
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="input w-40 px-2 py-1 text-xs"
            />
          </label>
          <label className="block">
            <span className="label">Court/pitch</span>
            <input
              value={court}
              onChange={(e) => setCourt(e.target.value)}
              className="input w-28 px-2 py-1 text-xs"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={saveSchedule}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      )}
    </li>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
