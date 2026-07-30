"use client";

// Which divisions a JOINT AI run covers (#350 §9). It sits above the quote card
// on the competition board: pick the divisions, then read what they cost.
//
// It exists to keep two server rules from being discovered as errors after the
// organiser has committed:
//
//   * A division with nothing movable is dropped before the run is quoted
//     (ruling R6). Offering it as selectable would let someone tick a division,
//     read a price, and get a plan that silently does not include it — so it is
//     shown (they need to know why it is missing) and not selectable.
//   * Fewer than two solvable divisions is 400 AI_PLAN_SINGLE_DIVISION. The
//     request schema deliberately does NOT enforce it — `division_ids` is
//     `.min(1)` and the orchestrator is the sole authority — which makes this
//     picker the only place the rule can be a SHAPE rather than a failure.
import { usePlural, type useMsg } from "@/components/i18n/dict-provider";

export interface PickerDivision {
  id: string;
  name: string;
  /** Movable ("scheduled") fixtures the AI would place in this division. */
  movable: number;
  /** The division's schedule is frozen. The plan endpoint answers 409
   *  SCHEDULE_LOCKED for a single frozen division and refuses the WHOLE run —
   *  so including one loses the run to a division nobody meant to change. */
  locked?: boolean;
}

/** The joint solve needs at least this many distinct divisions, or the run is
 *  a single-division run wearing the joint run's batch discount. */
export const MIN_JOINT_DIVISIONS = 2;

/** Divisions a joint run can actually include — see ruling R6 above, plus the
 *  frozen-division refusal. */
export function selectableDivisions(divisions: PickerDivision[]): PickerDivision[] {
  return divisions.filter((d) => d.movable > 0 && d.locked !== true);
}

/** Default selection: everything with something to place. An organiser who
 *  opened the console on the competition board meant "all of it". */
export function defaultSelectedDivisionIds(divisions: PickerDivision[]): string[] {
  return selectableDivisions(divisions).map((d) => d.id);
}

/** DISTINCT divisions, not array entries: the orchestrator de-duplicates before
 *  it counts, so `[d, d]` is one division and must not read as ready. */
export function jointRunReady(selected: string[]): boolean {
  return new Set(selected).size >= MIN_JOINT_DIVISIONS;
}

export function AiDivisionPicker({
  divisions,
  selected,
  onChange,
  msg,
  busy,
}: {
  divisions: PickerDivision[];
  selected: string[];
  onChange: (ids: string[]) => void;
  msg: ReturnType<typeof useMsg>;
  busy: boolean;
}) {
  const plural = usePlural();
  const selectable = selectableDivisions(divisions);
  const chosen = selected.filter((id) => selectable.some((d) => d.id === id));

  const toggle = (id: string) =>
    onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);

  return (
    <section
      aria-label={msg("board.ai.picker.aria")}
      className="rounded-lg border border-slate-200 bg-white"
    >
      <p className="flex items-baseline justify-between gap-3 border-b border-slate-100 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          {msg("board.ai.picker.title")}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-slate-400">
          {msg("board.ai.picker.selected", { count: chosen.length, total: selectable.length })}
        </span>
      </p>

      <ul className="divide-y divide-slate-100">
        {divisions.map((d) => {
          const usable = d.movable > 0 && d.locked !== true;
          return (
            <li key={d.id}>
              <label
                className={`flex items-center gap-2.5 px-3 py-2 ${
                  usable ? "cursor-pointer hover:bg-violet-50/40" : "cursor-not-allowed opacity-60"
                }`}
              >
                <input
                  type="checkbox"
                  data-division-id={d.id}
                  checked={usable && chosen.includes(d.id)}
                  disabled={busy || !usable}
                  onChange={() => toggle(d.id)}
                  className="h-4 w-4 shrink-0 rounded border-slate-300 text-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1"
                />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
                  {d.name}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-slate-500">
                  {/* Two different reasons a division cannot join, said
                      separately: one shared "can't use this" would send an
                      organiser off to add fixtures to a division that only
                      needs unfreezing. */}
                  {usable
                    ? plural("board.ai.picker.movable", d.movable)
                    : d.movable === 0
                      ? msg("board.ai.picker.nothingToPlace")
                      : msg("board.ai.picker.frozen")}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {!jointRunReady(chosen) && (
        <p
          role="status"
          className="m-3 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-snug text-amber-900"
        >
          <span aria-hidden>⚠</span>
          <span>{msg("board.ai.picker.needTwo")}</span>
        </p>
      )}
    </section>
  );
}
