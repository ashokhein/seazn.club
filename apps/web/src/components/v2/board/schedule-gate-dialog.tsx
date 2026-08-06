"use client";

// The organiser's way through the publish gate (#230 item 2 follow-up).
//
// `publishSchedule` and `startDivision` both refuse a board they will not put in
// front of players, with two codes that mean very different things:
//
//   SCHEDULE_UNACKNOWLEDGED_WARNINGS — "we can, but look at this first". There
//     IS a way through: re-send with `acknowledge_warnings: true`.
//   SCHEDULE_BLOCKING_CONFLICTS — physically impossible. There is NO way
//     through, by design: the flag is checked strictly after the blocking test
//     and can never reach it, and division status is forward-only
//     (setup → scheduled → active → completed) with no unpublish.
//
// So the two states are ONE dialog with a structural difference, not a shared
// dialog with a disabled button. A greyed-out "Publish anyway" says "not yet"
// and invites the organiser to hunt for the condition that ungreys it; the
// blocking case has no such condition. `ConfirmDialog` renders no confirm button
// at all when `confirmLabel` is omitted.
import { ConfirmDialog } from "@/components/v2/confirm-dialog";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import type { FeedLabelPair } from "@/lib/schedule-board";
import {
  CONFLICT_HELP,
  CONFLICT_LABEL,
  cardTitle,
  type BoardConflict,
  type BoardFixture,
} from "./types";

/** Which action was refused. Only the copy differs — the contract does not. */
export type GateAction = "publish" | "start";

export interface ScheduleGate {
  /** `blocking` has no confirm affordance; `warnings` does. */
  kind: "blocking" | "warnings";
  action: GateAction;
  conflicts: BoardConflict[];
}

export function ScheduleGateDialog({
  gate,
  board,
  entrantNames,
  feedLabels,
  busy = false,
  onConfirm,
  onDismiss,
}: {
  /** `null` closes it. The whole dialog is driven by the last refusal. */
  gate: ScheduleGate | null;
  board: BoardFixture[];
  entrantNames: Record<string, string>;
  feedLabels: Record<string, FeedLabelPair>;
  busy?: boolean;
  /** Re-send the same action with `acknowledge_warnings: true`. Never called in
   *  the blocking case — there is no control that calls it. */
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const msg = useMsg();
  // The same two lookups the conflicts panel uses, so a code reads identically
  // whether the organiser met it in the panel or in this refusal.
  const label = (code: string) => {
    const key = `board.conflict.${code}` as MessageKey;
    const out = msg(key);
    return out === key ? (CONFLICT_LABEL[code] ?? code) : out;
  };
  const help = (code: string, detail?: string) => {
    const key = `board.conflictHelp.${code}` as MessageKey;
    const out = msg(key);
    return out === key ? (CONFLICT_HELP[code] ?? detail ?? "") : out;
  };

  if (!gate) return null;
  const warning = gate.kind === "warnings";
  const byId = new Map(board.map((f) => [f.id, f]));
  const title = warning
    ? msg(gate.action === "start" ? "board.gate.warnTitleStart" : "board.gate.warnTitlePublish")
    : msg("board.gate.blockTitle");

  return (
    <ConfirmDialog
      open
      testId="board-gate"
      title={title}
      // THE structural difference. Omitted, not disabled, in the blocking case.
      confirmLabel={
        warning
          ? msg(gate.action === "start" ? "board.gate.startAnyway" : "board.gate.publishAnyway")
          : undefined
      }
      cancelLabel={warning ? msg("board.cancel") : msg("board.gate.dismiss")}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onDismiss}
    >
      <p data-kind={gate.kind} data-action={gate.action}>
        {warning
          ? msg(gate.action === "start" ? "board.gate.warnBodyStart" : "board.gate.warnBodyPublish")
          : msg("board.gate.blockBody")}
      </p>
      {/* Scrolls inside itself: a board can be refused on a dozen conflicts and
          the sheet must still fit a 375px phone without the page scrolling. */}
      <ul className="max-h-56 space-y-2 overflow-y-auto">
        {gate.conflicts.map((c, i) => {
          const f = byId.get(c.fixture_id);
          return (
            <li
              key={`${c.fixture_id}-${c.code}-${i}`}
              data-testid="board-gate-conflict"
              data-code={c.code}
              data-blocking={c.blocking ? "yes" : "no"}
              className={`rounded-lg border p-2 text-xs ${
                c.blocking ? "border-red-200 bg-red-50/60" : "border-amber-200 bg-amber-50/60"
              }`}
            >
              <p className="font-medium text-slate-800">
                {f
                  ? cardTitle(f, entrantNames, feedLabels)
                  : msg("board.conflicts.removedFixture")}
              </p>
              <p className="mt-0.5 text-slate-600">
                <span
                  className={`mr-1 rounded px-1 font-semibold ${
                    c.blocking ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {label(c.code)}
                </span>
                {help(c.code, c.detail)}
              </p>
            </li>
          );
        })}
      </ul>
    </ConfirmDialog>
  );
}
