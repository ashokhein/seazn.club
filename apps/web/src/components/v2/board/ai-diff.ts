// Client-side schedule diff (v4 Task 13, design/v4/02 §1/§3). The engine returns
// a verified proposal with a server `diff` (id arrays only); the console recomputes
// the same buckets enriched with from→to provenance — the diff panel renders that
// provenance ("was Court 2 · 13:30 → Court 1 · 14:00", never on the grid block per
// §3) and the board derives each ghost's state-palette tone from it. Pure and
// React-free so the bucketing is unit-testable and asserted against the server diff.
import type { AiPlanResponse } from "@/server/api-v1/schemas";
import type { MessageKey } from "@/lib/messages";
import { REASON_CODE } from "@/lib/schedule-board";

/** A fixture's current placement — the board's live truth before the proposal. */
export interface AiFixtureRef {
  id: string;
  /** ISO string (or null when the fixture sits unscheduled in the tray). */
  scheduled_at: string | null;
  court_label: string | null;
}

/** A fixture enriched with what a ghost block / diff row shows (design §3): a
 *  short code, the matchup line, and the persistent JR/Final marker — carried
 *  from the board (which owns entrant names + stage shape) into the console. */
export interface AiConsoleFixture extends AiFixtureRef {
  code: string;
  matchup: string;
  isFinal: boolean;
  isJunior: boolean;
}

/** One court/time slot — the shared shape of a from/to/at position. */
export interface AiDiffSlot {
  scheduled_at: string;
  court_label: string | null;
}

export interface AiDiffMoved {
  fixture_id: string;
  from: AiDiffSlot;
  to: AiDiffSlot;
}
export interface AiDiffPlaced {
  fixture_id: string;
  to: AiDiffSlot;
}
export interface AiDiffUnscheduled {
  fixture_id: string;
  from: AiDiffSlot;
}
export interface AiDiffUnchanged {
  fixture_id: string;
  at: AiDiffSlot;
}

export interface AiDiff {
  /** Placed elsewhere than they were — the AI's changes (amber, §1). */
  moved: AiDiffMoved[];
  /** Were in the tray, now on the board (teal, §1). */
  placed: AiDiffPlaced[];
  /** Were on the board, dropped from the proposal to the tray (neutral). */
  unscheduled: AiDiffUnscheduled[];
  /** Same court + same instant as now — untouched (dimmed, §1). */
  unchanged: AiDiffUnchanged[];
}

/** Same court and same wall-clock instant — an ISO restatement is not a move. */
function sameSlot(a: AiFixtureRef | AiDiffSlot, b: AiDiffSlot): boolean {
  if ((a.court_label ?? null) !== (b.court_label ?? null)) return false;
  const ta = a.scheduled_at ? new Date(a.scheduled_at).getTime() : NaN;
  const tb = new Date(b.scheduled_at).getTime();
  return ta === tb;
}

/**
 * Bucket the proposal against the board's current placements. Mirrors the engine's
 * server diff (see AiPlanResponse.diff) so a mismatch is a caught regression, not
 * a silent drift: a proposal entry is `placed` when the fixture had no current
 * slot, `unchanged` when the slot is identical, else `moved`; a currently-placed
 * fixture absent from the proposal is `unscheduled`.
 */
export function computeAiDiff(plan: AiPlanResponse, current: AiFixtureRef[]): AiDiff {
  const cur = new Map(current.map((f) => [f.id, f]));
  const proposedIds = new Set(plan.proposal.map((p) => p.fixture_id));
  const diff: AiDiff = { moved: [], placed: [], unscheduled: [], unchanged: [] };

  for (const p of plan.proposal) {
    const to: AiDiffSlot = { scheduled_at: p.scheduled_at, court_label: p.court_label ?? null };
    const now = cur.get(p.fixture_id);
    if (!now || now.scheduled_at === null) {
      diff.placed.push({ fixture_id: p.fixture_id, to });
    } else if (sameSlot(now, to)) {
      diff.unchanged.push({ fixture_id: p.fixture_id, at: to });
    } else {
      diff.moved.push({
        fixture_id: p.fixture_id,
        from: { scheduled_at: now.scheduled_at, court_label: now.court_label },
        to,
      });
    }
  }

  for (const f of current) {
    if (f.scheduled_at !== null && !proposedIds.has(f.id)) {
      diff.unscheduled.push({
        fixture_id: f.id,
        from: { scheduled_at: f.scheduled_at, court_label: f.court_label },
      });
    }
  }

  return diff;
}

/** The state-palette bucket a ghost/diff row paints in (design/v4/02 §1). */
export type GhostTone = "moved" | "placed" | "unchanged" | "blocking";

/**
 * The tone for one fixture: a blocking conflict (red) always wins over its diff
 * bucket — a moved-but-blocking fixture must read as caught, not as a tidy change.
 * Anything the proposal did not touch falls back to `unchanged` (dimmed).
 */
export function ghostToneFor(fixtureId: string, diff: AiDiff, blocking: Set<string>): GhostTone {
  if (blocking.has(fixtureId)) return "blocking";
  if (diff.moved.some((m) => m.fixture_id === fixtureId)) return "moved";
  if (diff.placed.some((p) => p.fixture_id === fixtureId)) return "placed";
  return "unchanged";
}

/**
 * The API conflict code a blocking row's engine `reason` maps to (v4 Task 13,
 * design/v4/02 §6). A blocking row carries the engine verifier's raw camelCase
 * reason token (`court`, `order`, …); this routes it through the one shared
 * REASON_CODE table (lib/schedule-board — the same map the server applies) so
 * the console reaches the board's localized `board.conflict.*` labels instead
 * of leaking the engine's English `detail`. An unmapped token falls through as
 * its own pseudo-code, so the caller's fallback mirrors the conflicts panel
 * (CONFLICT_LABEL[code] ?? code) rather than the raw engine string.
 */
export function blockingConflictCode(reason: string): string {
  return REASON_CODE[reason as keyof typeof REASON_CODE] ?? reason;
}

/** The `board.conflict.*` dict key for a blocking row's engine reason — the
 *  reason→dict-key helper the diff panel localizes with useMsg(), the exact
 *  keys the conflicts panel resolves for a drag-drop conflict code. */
export function blockingConflictKey(reason: string): MessageKey {
  return `board.conflict.${blockingConflictCode(reason)}` as MessageKey;
}
