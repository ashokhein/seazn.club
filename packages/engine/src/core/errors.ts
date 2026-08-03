// EngineError taxonomy — spec 03 §7. Typed codes, never bare strings; the API
// layer maps codes → HTTP (409/422/402) centrally and surfaces messages
// verbatim in the UI.
import { z } from "zod";

// spec 03 §7
export const EngineErrorCode = z.enum([
  "INVALID_EVENT",
  "WRONG_PHASE",
  "ALREADY_DECIDED",
  "LINEUP_INVALID",
  "CONFIG_INVALID",
  "SEQ_CONFLICT",
  "STAGE_NOT_READY",
  // PROMPT-17 — a schedule write hit a blocking conflict (doc 12 §2:
  // conflict.court, or warn.order on a direct feed). data.conflicts lists them.
  "SCHEDULE_CONFLICT",
  // PROMPT-61 — a stage whose supportsDraws(cfg, kind) is false refused to
  // finalize a level outcome; decide it by extra time / a shootout.
  "DRAW_NOT_ALLOWED",
  // PROMPT-59 — a qualification spec is structurally invalid (e.g. the same
  // entrant qualifying through two combined tiers).
  "QUALIFICATION_INVALID",
  "ELIGIBILITY",
  // PROMPT-03 — registry resolution (spec 03 §3 registry & versioning).
  "MODULE_NOT_FOUND",
  "MODULE_DUPLICATE",
  // W4a (#425) §7 — the core time model. Appended, never reordered: the enum
  // order is asserted in errors.test.ts and read by the API's code → HTTP map.
  // A stamped event's `at` precedes the newest accepted stamp (spec §3.3).
  "NON_MONOTONIC_TIME",
  // `compareGameTime` (core/time.ts) received a period absent from the phase
  // order it was handed. TWO call paths reach it, and naming only the first
  // sent a reader looking in the wrong file: a module's own comparisons inside
  // `apply()` (the sweep, release-on-goal), and the fold kernel's monotonic
  // guard, which compares each stamp against the high-water mark. It is
  // therefore a disagreement between two lists, never a scorer's typo — an
  // `at.period` the module does not declare is refused earlier, by the fold, as
  // INVALID_EVENT. Still a 422: it rejects one event, and paging the on-call
  // gives the scorer nothing.
  "UNKNOWN_PHASE",
  // Expedite in force, `serving` recorded, and a 13-return rally credited to
  // the serving side (spec §5.3). Declared here, thrown by the set-based
  // kernel in a later task.
  "EXPEDITE_WRONG_WINNER",
  // Football substitution beyond `subWindows` or `cfg.maxSubs` (spec §5.2).
  // Declared here, thrown by the football module in a later task.
  "SUB_WINDOW_EXCEEDED",
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCode>;

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly data?: unknown;

  constructor(code: EngineErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.data = data;
  }

  is(code: EngineErrorCode): boolean {
    return this.code === code;
  }

  static is(err: unknown, code?: EngineErrorCode): err is EngineError {
    return err instanceof EngineError && (code === undefined || err.code === code);
  }
}
