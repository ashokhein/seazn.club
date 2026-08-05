"use client";

// Result strip (z3 auto-schedule, Task 11) — what the solver actually achieved,
// stated plainly, directly under the green "Placed N matches" notice.
//
// WHY IT EXISTS. The solver is *anytime*: it returns the best board it found
// inside a time budget, which may be neither optimal nor complete. Every number
// it reports is therefore a claim that has to be qualified, and the strip is
// where that qualification lives. A strip showing only the happy numbers would
// be worse than no strip, because it implies a completeness the run did not
// deliver. Three rules follow from that, and they are what the tests pin:
//
//   1. `placed` vs `total` is stated whenever they differ. The green notice
//      above says how many landed; only this line says how many did not.
//   2. `budget_expired` is never swallowed. "Improved 2 of 4 targets and then
//      stopped" is the honest reading of a truncated anytime run.
//   3. `infeasible` is a proof about the PINNED cards, not about the board.
//      Measured on the engine lane: 20 clean fixtures + 2 contradictory pins
//      returns 20 placed with exactly those 2 dropped. Rendering that as "no
//      schedule is possible" would be false and unactionable, so the copy names
//      the placement split and the pins and nothing else.
//
// DESIGN. Deliberately never green: the emerald notice directly above already
// carries the good news, and the strip's whole job is the part that line does
// not say. Two tones only — neutral slate when there is nothing to flag, amber
// when there is. The metrics sit in a hairline grid (gap-px over a tinted
// container) that reflows 4 -> 2 columns at mobile without ever overflowing the
// page, and a plain-language legend under it explains the two labels that are
// jargon, so the explanation survives on touch where a tooltip would not.
import { useMsg, usePlural } from "@/components/i18n/dict-provider";
import type { ScheduleMetrics, ScheduleSolverInfo } from "@/server/api-v1/schemas";

const ENGINE_KEY = {
  greedy: "board.result.engine.greedy",
  z3: "board.result.engine.z3",
  "z3+lns": "board.result.engine.z3lns",
} as const;

/** Status -> the one sentence that says what the solver did. `ok` splits on the
 *  engine: a greedy `ok` means the quick pass produced the board and nothing was
 *  optimised, which is a different statement from an optimised `ok`. */
function statusKey(solver: ScheduleSolverInfo) {
  switch (solver.status) {
    case "ok":
      return solver.engine === "greedy" ? "board.result.quick" : "board.result.ok";
    case "already_optimal":
      return "board.result.alreadyOptimal";
    case "solver_busy":
      return "board.result.busy";
    case "z3_unavailable":
      return "board.result.unavailable";
    case "verifier_rejected":
      return "board.result.verifierRejected";
    case "infeasible":
      return "board.result.infeasibleAllPlaced";
  }
}

export function ScheduleResultStrip({
  metrics,
  solver,
  pinnedConflictCount,
}: {
  metrics: ScheduleMetrics;
  solver: ScheduleSolverInfo;
  /** An explicit override for the pin count. Rarely needed now: Task 9 put
   *  `solver.contradictory_pins` on the wire and it is preferred over this. Kept
   *  because a caller that knows better than the payload should be able to say
   *  so, and removing a prop is not this component's problem to solve. */
  pinnedConflictCount?: number;
}) {
  const msg = useMsg();
  const plural = usePlural();

  const dur = (mins: number): string => {
    const m = Math.max(0, Math.round(mins));
    const h = Math.floor(m / 60);
    return h > 0 ? msg("board.result.dur.hm", { h, m: m % 60 }) : msg("board.result.dur.m", { m });
  };
  const elapsed =
    solver.elapsed_ms >= 1000
      ? msg("board.result.dur.s", { s: (solver.elapsed_ms / 1000).toFixed(1) })
      : msg("board.result.dur.ms", { ms: Math.round(solver.elapsed_ms) });

  const dropped = Math.max(0, metrics.total - metrics.placed);
  const partial = dropped > 0;
  /**
   * How many PINNED cards the infeasibility proof is about.
   *
   * THREE sources, in descending order of how much they actually know:
   *
   *   1. `solver.contradictory_pins` — the engine naming the pinned set its
   *      proof is about. The only one of the three that is a fact.
   *   2. an explicit prop, for a caller that knows better than the payload.
   *   3. `total - placed`, the fallback from before the field existed. It is
   *      right only when every unplaced card is a pinned one, and silently
   *      overstates the moment that stops holding — a board that also lost two
   *      cards to a full court reports four contradictory pins where there are
   *      two. Kept because a server one deploy behind sends no pins at all, and
   *      a wrong count reads better than a blank sentence.
   */
  const pinCount = solver.contradictory_pins?.length ?? pinnedConflictCount ?? dropped;
  // Amber is reserved for "there is something here you need to know about your
  // board". `verifier_rejected` deliberately does NOT qualify: it is an internal
  // fault the organiser cannot act on, their board is valid either way, and the
  // loud part of that failure belongs in our logs, not on their screen.
  // `solver_busy` and `z3_unavailable` are likewise ordinary, not alarming.
  const flagged = partial || solver.status === "infeasible";

  // The headline is the single most honest thing we can say. An incomplete board
  // outranks the status sentence for that slot; a complete one lets the status
  // speak for itself.
  const headline = partial
    ? solver.status === "infeasible"
      ? plural("board.result.partialPinned", pinCount, {
          placed: metrics.placed,
          total: metrics.total,
        })
      : plural("board.result.partial", dropped, { placed: metrics.placed, total: metrics.total })
    : msg(statusKey(solver));
  // `infeasible` already spent its sentence on the headline — repeating it would
  // say the same thing twice in two different registers.
  const secondary = partial && solver.status !== "infeasible" ? msg(statusKey(solver)) : null;

  const cells: { label: string; value: string; alert?: boolean }[] = [
    { label: msg("board.result.metric.length"), value: dur(metrics.makespan_minutes) },
    { label: msg("board.result.metric.longestGap"), value: dur(metrics.worst_idle_gap_minutes) },
    { label: msg("board.result.metric.courtSpread"), value: dur(metrics.court_imbalance_minutes) },
    {
      label: msg("board.result.metric.scheduled"),
      value: `${metrics.placed} / ${metrics.total}`,
      alert: partial,
    },
  ];

  return (
    <section
      data-testid="schedule-result-strip"
      data-tone={flagged ? "flag" : "plain"}
      data-status={solver.status}
      aria-label={msg("board.result.aria")}
      className={`rounded-lg border px-3 py-2.5 ${
        flagged ? "border-amber-200 bg-amber-50/70" : "border-slate-200 bg-slate-50"
      }`}
    >
      <p
        data-testid="schedule-result-headline"
        className={`text-sm font-semibold ${flagged ? "text-amber-900" : "text-slate-800"}`}
      >
        {headline}
      </p>
      {secondary && <p className="mt-0.5 text-xs text-slate-600">{secondary}</p>}

      {/* Capped rather than stretched: on a wide board a full-bleed rail leaves
          each number stranded at the left of a 250px cell, which reads as an
          empty table. 2 columns on mobile, 4 from `sm`, never wider than this. */}
      <dl className="mt-2.5 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 sm:max-w-xl sm:grid-cols-4">
        {cells.map((c) => (
          // col-reverse so the number reads first while <dt> keeps its required
          // source position ahead of <dd>.
          <div key={c.label} className="flex flex-col-reverse bg-white px-2.5 py-1.5">
            <dt className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              {c.label}
            </dt>
            <dd
              className={`text-[15px] font-semibold tabular-nums ${
                c.alert ? "text-amber-700" : "text-slate-800"
              }`}
            >
              {c.value}
            </dd>
          </div>
        ))}
      </dl>

      {solver.budget_expired && (
        // The denominator comes off the WIRE (`tiers_total`), not from a
        // constant here. The tier ladder lives in the engine, this component
        // lives two packages away, and a copy of its length in each is a
        // divergence with nothing to notice it — which is exactly what a
        // hardcoded `IMPROVEMENT_TARGETS = 4` was.
        <p data-testid="schedule-result-budget" className="mt-2 text-xs text-slate-600">
          {msg("board.result.budgetExpired", {
            n: solver.tiers_completed,
            total: solver.tiers_total,
          })}
        </p>
      )}

      <p className="mt-1.5 text-[11px] leading-snug text-slate-400">{msg("board.result.legend")}</p>
      <p
        data-testid="schedule-result-provenance"
        className="mt-1 text-[11px] tabular-nums text-slate-400"
      >
        {msg(ENGINE_KEY[solver.engine])} · {elapsed} ·{" "}
        {solver.moved > 0 ? plural("board.result.moved", solver.moved) : msg("board.result.movedNone")}
      </p>
    </section>
  );
}
