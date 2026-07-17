"use client";

// Fixture console per stage (PROMPT-15 task 1, rebuilt per v3/04 §3): rounds
// grouped with date ranges, competition-timezone rendering, pinned
// unscheduled section with an auto-schedule CTA, "Now playing" strip, inline
// reschedule with undo, bye/void ghost rows, sticky round headers on mobile,
// print via the DocModel timetable export. Scoring lives on the fixture page.
import { useState } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { routes } from "@/lib/routes";
import { ClientDateRange, ClientTime } from "@/components/client-time";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useConfirm } from "@/components/ui/confirm-provider";
import { TipCallout } from "@/components/ui/tip";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

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
  const msg = useMsg();
  const confirmDialog = useConfirm();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // stage id in flight
  const [notice, setNotice] = useState<string | null>(null);
  // "Générer les matchs" precondition-not-met (design/fix-ui/03 §"misleading
  // success message"): distinct from `notice` (success, green) and `error`
  // (generic failure, red) — an amber, actionable "here's what to fix" state
  // so it's never confused with the "nothing new — up to date" success copy.
  const [warning, setWarning] = useState<string | null>(null);
  // Set after an inline reschedule lands: the notice grows an Undo button
  // that steps the division history back one event (Jul3/03).
  const [undoable, setUndoable] = useState(false);

  async function undoLast() {
    setError(null);
    try {
      await apiV1(`/api/v1/divisions/${divisionId}/undo`, { method: "POST", json: {} });
      setNotice(msg("schedule.notice.undone"));
      setUndoable(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("schedule.error.undoFailed"));
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
        setNotice(msg("schedule.notice.nothingToSchedule"));
        return;
      }
      const applied = await apiV1<{ applied: number }>(`/api/v1/stages/${stageId}/schedule/apply`, {
        method: "POST",
        json: { assignments: out.assignments, source: "auto" },
      });
      setNotice(msg("schedule.notice.placed", { n: applied.applied }));
      setUndoable(true);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
      }
    } finally {
      setBusy(null);
    }
  }

  async function act(stageId: string, action: "generate" | "complete" | "delete") {
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setWarning(null);
    setBusy(stageId);
    try {
      if (action === "delete") {
        await apiV1(`/api/v1/stages/${stageId}`, { method: "DELETE" });
        setNotice(msg("schedule.notice.stageDeleted"));
      } else if (action === "generate") {
        const out = await apiV1<{ created: number; existing: number }>(
          `/api/v1/stages/${stageId}/generate`,
          { method: "POST", json: {} },
        );
        setNotice(
          out.created > 0
            ? msg("schedule.notice.generated", { created: out.created, existing: out.existing })
            : msg("schedule.notice.nothingNew"),
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
            ? msg("schedule.notice.notReady")
            : out.division_completed
              ? msg("schedule.notice.divisionFinished")
              : out.next_stage_fixtures !== undefined
                ? msg("schedule.notice.advanced", {
                    n: out.qualified?.entrants.length ?? "",
                    gen: out.next_stage_fixtures,
                  })
                : msg("schedule.notice.completed"),
        );
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        const precondition = generatePreconditionMessage(err, msg);
        if (precondition) {
          setWarning(precondition);
        } else {
          setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
        }
      }
    } finally {
      setBusy(null);
    }
  }

  if (stages.length === 0) {
    return <p className="text-sm text-slate-500">{msg("schedule.noStages")}</p>;
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
      {/* Precondition-not-met (amber, actionable) — never the green success
          banner: "Générer les matchs" did nothing because the entrants can't
          fill the configured groups yet, not because it was already done. */}
      {warning && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p>
      )}
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
            {msg("schedule.print")}
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
                  {f.home_entrant_id ? (entrantNames[f.home_entrant_id] ?? "?") : msg("schedule.tbd")}{" "}
                  {msg("schedule.vs")}{" "}
                  {f.away_entrant_id ? (entrantNames[f.away_entrant_id] ?? "?") : msg("schedule.tbd")}
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
        // League/group rounds display in ACTUAL earliest-kickoff order, not
        // generation order (round_no) — auto-scheduling (parallel courts) or a
        // manual reschedule can leave a later-numbered round with an earlier
        // kickoff than one before it, which would mislead an organiser reading
        // the round list for "what's next" (design/fix-ui/03 §"rounds out of
        // order"). Rounds with no scheduled fixture yet have no time to sort
        // by, so they fall back to round_no order after every dated round.
        // Bracket stages (splitRounds below) are structural, not chronological
        // (Quarter → Semi → Final), so they keep round_no order untouched.
        const orderedRounds = [...rounds].sort((a, b) => {
          const da = roundDates(a).from;
          const db = roundDates(b).from;
          if (da !== null && db !== null) return da < db ? -1 : da > db ? 1 : a - b;
          if (da !== null) return -1;
          if (db !== null) return 1;
          return a - b;
        });
        // Mirrors the server guard (deleteStage) EXACTLY: only the last stage
        // in the graph, and only when it owns no played fixtures. No "keep one
        // stage" rule — the server deletes the sole stage of a pure League too,
        // which is the only escape from the format lock once fixtures exist.
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
              <span className={`badge ${stageStatusStyle(stage.status)}`}>{stageStatusLabel(msg, stage.status)}</span>
              <div className="flex-1" />
              {canEdit && stage.status !== "complete" && (
                <>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => act(stage.id, "generate")}
                    className="btn btn-ghost px-3 py-1.5 text-xs"
                  >
                    {busy === stage.id
                      ? msg("schedule.working")
                      : stage.kind === "swiss"
                        ? msg("schedule.pairNext")
                        : msg("schedule.generate")}
                  </button>
                  {stageFixtures.length > 0 && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => act(stage.id, "complete")}
                      className="btn btn-primary px-3 py-1.5 text-xs"
                    >
                      {msg("schedule.complete")}
                    </button>
                  )}
                </>
              )}
              {canEdit && deletable && (
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
                  {msg("schedule.delete")}
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
                      {busy === stage.id ? msg("schedule.working") : msg("schedule.unscheduled.cta")}
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
                {canEdit ? msg("schedule.noFixtures.can") : msg("schedule.noFixtures.view")}
              </p>
            ) : splitRounds ? null : (
              <div className="divide-y divide-slate-100">
                {orderedRounds.map((round) => {
                  const dates = roundDates(round);
                  return (
                  <div key={round}>
                    {/* Sticky round header (items 1 + 7): label + date range. */}
                    <p className="sticky top-0 z-10 flex items-baseline gap-2 border-y border-slate-300 bg-slate-200 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600">
                      {msg("schedule.round", { n: round })}
                      {dates.from && (
                        <span data-testid="round-dates" className="font-medium normal-case text-slate-500">
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
                    {stage.name} — {bracketRoundLabel(msg, stage.kind, round, maxRound)}
                    {dates.from && (
                      <span data-testid="round-dates" className="normal-case text-slate-500">
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
          onDone={(noticeMsg) => {
            setNotice(noticeMsg);
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
// server seeds + generates on the spot. Kind labels are format names (kept
// canonical/English, like the format gallery).
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
  const msg = useMsg();
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
        onDone(msg("schedule.notice.stageAdded", { n: gen.created, topN }));
      } catch (err) {
        // Previous stage not complete yet — the stage exists; completion will
        // seed + generate it.
        if (err instanceof ApiV1Error && err.code === "STAGE_NOT_READY") {
          onDone(msg("schedule.notice.stageAddedLater"));
        } else {
          throw err;
        }
      }
      setOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : msg("schedule.error.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost text-xs">
        {msg("schedule.addStage")}
      </button>
    );
  }

  return (
    <section className="card flex flex-wrap items-end gap-3 p-4">
      <label className="block">
        <span className="label">{msg("schedule.field.stageName")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          className="input w-40"
        />
      </label>
      <label className="block">
        <span className="label">{msg("schedule.field.format")}</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="select">
          {ADD_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="label">{msg("schedule.field.qualifyFrom")}</span>
        <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} className="select">
          {[2, 3, 4, 6, 8].map((n) => (
            <option key={n} value={n}>
              {msg("schedule.topN", { n })}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={add} className="btn btn-primary text-xs">
        {busy ? msg("schedule.adding") : msg("schedule.addStageBtn")}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost text-xs">
        {msg("schedule.cancel")}
      </button>
    </section>
  );
}

const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder"]);

/**
 * "Générer les matchs" precondition failure (design/fix-ui/03 §"misleading
 * success message"): generateStageFixtures throws STAGE_NOT_READY with
 * `data.reason: "group_too_few_entrants"` when a group stage passed the
 * total-entrant gate but can't pair fixtures once split across its
 * configured groups. Returns the actionable, localized reason to show as a
 * distinct (amber, non-success) banner — or null for every other error,
 * which the caller falls through to the generic red error banner for.
 * Exported (pure, no state) so this classification is unit-testable without
 * a DOM/jsdom harness, which this repo's component tests don't set up.
 */
export function generatePreconditionMessage(err: unknown, msg: Msg): string | null {
  if (
    !(err instanceof ApiV1Error) ||
    err.code !== "STAGE_NOT_READY" ||
    err.extra.reason !== "group_too_few_entrants"
  ) {
    return null;
  }
  const groups = Number(err.extra.groups ?? 1);
  return groups > 1
    ? msg("schedule.error.tooFewGroupEntrants", {
        required: Number(err.extra.required ?? groups * 2),
        have: Number(err.extra.entrants ?? 0),
        groups,
      })
    : msg("schedule.error.tooFewEntrants");
}

/** A bye: one side empty with an auto-advance award outcome (v3/04 §3 item 6). */
function isBye(f: FixtureRow): boolean {
  const o = f.outcome as { kind?: string } | null;
  return o?.kind === "award" && (f.home_entrant_id === null || f.away_entrant_id === null);
}

/** Voided fixtures render struck through with the reason (item 6). */
const VOID_STATUSES = new Set(["cancelled", "abandoned", "forfeited"]);

// Named bracket rounds, by distance from the last round. Double-elim round
// numbers encode WB/LB/GF lanes, so plain "Round N" stays honest there.
function bracketRoundLabel(msg: Msg, kind: string, roundNo: number, maxRound: number): string {
  if (kind === "stepladder") return msg("schedule.bracket.rung", { n: roundNo });
  if (kind === "knockout") {
    const fromEnd = maxRound - roundNo;
    if (fromEnd === 0) return msg("schedule.bracket.final");
    if (fromEnd === 1) return msg("schedule.bracket.semi");
    if (fromEnd === 2) return msg("schedule.bracket.quarter");
  }
  return msg("schedule.round", { n: roundNo });
}

function stageStatusStyle(status: string): string {
  if (status === "active") return "bg-amber-100 text-amber-700";
  if (status === "complete") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-600";
}

/** Localized stage status; unknown values fall back to the raw token. */
function stageStatusLabel(msg: Msg, status: string): string {
  if (status === "active") return msg("schedule.sstatus.active");
  if (status === "complete") return msg("schedule.sstatus.complete");
  if (status === "pending") return msg("schedule.sstatus.pending");
  return status;
}

/** Localized played-fixture status; unknown values fall back to the raw token. */
function fixtureStatusLabel(msg: Msg, status: string): string {
  const key = `schedule.fstatus.${status}` as MessageKey;
  const label = msg(key);
  return label === key ? status.replace("_", " ") : label;
}

function outcomeText(msg: Msg, outcome: unknown, entrantNames: Record<string, string>): string | null {
  const o = outcome as { kind?: string; winner?: string } | null;
  if (!o?.kind) return null;
  const winner = entrantNames[o.winner ?? ""] ?? "?";
  switch (o.kind) {
    case "win":
      return msg("schedule.outcome.won", { name: winner });
    case "award":
      return msg("schedule.outcome.wonWo", { name: winner });
    case "draw":
      return msg("schedule.outcome.draw");
    case "tie":
      return msg("schedule.outcome.tie");
    case "no_result":
      return msg("schedule.outcome.noResult");
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
  const msg = useMsg();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(
    fixture.scheduled_at ? toLocalInput(fixture.scheduled_at) : "",
  );
  const [venue, setVenue] = useState(fixture.venue ?? "");
  const [court, setCourt] = useState(fixture.court_label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const home = fixture.home_entrant_id ? (entrantNames[fixture.home_entrant_id] ?? "?") : msg("schedule.tbd");
  const away = fixture.away_entrant_id ? (entrantNames[fixture.away_entrant_id] ?? "?") : msg("schedule.tbd");
  const decided = outcomeText(msg, fixture.outcome, entrantNames);

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
      setError(err instanceof Error ? err.message : msg("schedule.error.failed"));
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
          <span className="mx-1.5 text-slate-400">{msg("schedule.vs")}</span>
          <span className="font-medium">{away}</span>
          {decided && !voided && <span className="ml-2 text-xs text-slate-500 no-underline">{decided}</span>}
        </Link>
        {/* Timetable chip — reflects whether the match has a kick-off time. */}
        <span
          className={`badge ${timed ? "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200" : "bg-slate-100 text-slate-500"}`}
          title={timed ? msg("schedule.chip.timedTitle") : msg("schedule.chip.untimedTitle")}
        >
          {timed ? (
            <>
              {msg("schedule.chip.scheduled")} · <ClientTime value={fixture.scheduled_at} mode="datetime" tz={tz} showZone />
            </>
          ) : (
            msg("schedule.chip.unscheduled")
          )}
          {fixture.court_label ? ` · ${fixture.court_label}` : fixture.venue ? ` · ${fixture.venue}` : ""}
        </span>
        {/* Play state only once it's under way / done. */}
        {played && (
          <span className={`badge ${FIXTURE_STATUS_STYLE[fixture.status] ?? ""}`}>
            {fixtureStatusLabel(msg, fixture.status)}
          </span>
        )}
        {/* Scoring pad. */}
        <Link href={href} className="btn btn-ghost px-3 py-1 text-xs">
          {decided ? msg("schedule.view") : fixture.status === "in_play" ? msg("schedule.scoreLive") : msg("schedule.score")}
        </Link>
        {/* Timetable controls only while the match is still movable — once
            it's in play or decided the server refuses moves anyway, so the
            buttons would just be a dead end. */}
        {canEdit && fixture.status === "scheduled" && (
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="btn btn-ghost px-3 py-1 text-xs"
          >
            {editing ? msg("schedule.close") : timed ? msg("schedule.editTime") : msg("schedule.schedule")}
          </button>
        )}
        {canEdit && fixture.status === "scheduled" && timed && !editing && (
          <button
            type="button"
            disabled={busy}
            onClick={unschedule}
            className="text-xs text-slate-500 hover:text-red-600 hover:underline"
          >
            {msg("schedule.unschedule")}
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">{msg("schedule.field.when")}</span>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="input px-2 py-1 text-xs"
            />
          </label>
          <label className="block">
            <span className="label">{msg("schedule.field.venue")}</span>
            <input
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="input w-40 px-2 py-1 text-xs"
            />
          </label>
          <label className="block">
            <span className="label">{msg("schedule.field.court")}</span>
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
            {busy ? msg("schedule.saving") : msg("schedule.save")}
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
