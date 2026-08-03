// Core time model — W4a spec (#425) §2. Durations and elapsed-at-event.
//
// Three properties hold everywhere below, and every later wave depends on all
// three:
//
//  1. **The engine owns no clock.** Nothing here reads wall time; `core/clock.ts`
//     stays the only adapter seam, and it is never consulted inside a fold. A
//     countdown is a pad rendering a duration against a known start, not the
//     engine racing real time.
//  2. **`at` is a frozen fact recorded by the pad.** It arrives on the payload
//     as a value, exactly like a score. The engine cannot tell a stamp taken
//     from a running timer from one typed in off a paper sheet, and does not
//     need to — replay stays deterministic either way (§4).
//  3. **Seconds are GAME clock, not wall clock.** `elapsed` counts up from the
//     start of the named period and does NOT advance during a stoppage. A minor
//     started at 761 expires at 881 whether or not an eight-minute injury delay
//     intervened, because penalty time only runs while play runs (§1.2). Real
//     elapsed time remains available from the envelope's `recordedAt` delta.
//
// Every export is pure: no I/O, no hidden state, same inputs → same result.
// Most are total; three deliberately are NOT, and each throws an `EngineError`
// rather than coercing, because the coerced value was silently wrong rather
// than merely imprecise:
//
//   compareGameTime  UNKNOWN_PHASE  — a period outside the declared order
//   addDuration      INVALID_EVENT  — a negative or non-finite duration
//   remainingOf      INVALID_EVENT  — a non-finite period length
//
// `formatElapsed` and `parseElapsed` stay total: they are the manual-entry
// display and input path (§4), where junk is an expected input.
import { z } from "zod";
import { EngineError } from "./errors.ts";

/** Seconds. Non-negative integer. The engine's only unit of duration (§2). */
export const DurationSeconds = z.number().int().nonnegative();
export type DurationSeconds = z.infer<typeof DurationSeconds>;

/**
 * Elapsed-at-event: seconds counted UP from the start of `period` (§1.1).
 *
 * Not remaining-basis and not absolute-from-first-whistle: remaining needs the
 * period length to be comparable across events, and absolute loses the period
 * label every scoresheet in every one of these sports prints. Strict, so an
 * unknown key means "not a GameTime" rather than a silently widened shape —
 * `gameTimeOf` leans on that.
 *
 * `elapsed` MAY exceed the nominal period length (§1.3). Football's `90+3` is
 * `{ period: "H2", elapsed: 2880 }` against a nominal 2700; a hard bound here
 * would reject every stoppage-time goal ever scored.
 */
export const GameTime = z.strictObject({
  period: z.string().min(1),
  elapsed: DurationSeconds,
});
export type GameTime = z.infer<typeof GameTime>;

/**
 * Order two stamps: phase index first, then `elapsed`. `-1 | 0 | 1`.
 *
 * `0` means genuinely simultaneous, which is legal and common — `core.suspend`
 * and its `core.resume` share a stamp, and so do two penalties awarded at one
 * whistle (§1.2, §3.3).
 *
 * `phaseOrder` is supplied by the caller because core knows no sport's phase
 * list; period modules pass `playPhases`. A period absent from it throws
 * `UNKNOWN_PHASE` rather than sorting arbitrarily — silently ordering an
 * unrecognised period would make lazy expiry wrong in a way nothing detects.
 */
export function compareGameTime(
  a: GameTime,
  b: GameTime,
  phaseOrder: readonly string[],
): -1 | 0 | 1 {
  const ai = phaseOrder.indexOf(a.period);
  if (ai === -1) throw unknownPhase(a.period, phaseOrder);
  const bi = phaseOrder.indexOf(b.period);
  if (bi === -1) throw unknownPhase(b.period, phaseOrder);
  if (ai !== bi) return ai < bi ? -1 : 1;
  if (a.elapsed === b.elapsed) return 0;
  return a.elapsed < b.elapsed ? -1 : 1;
}

function unknownPhase(period: string, phaseOrder: readonly string[]): EngineError {
  return new EngineError("UNKNOWN_PHASE", `period "${period}" is not in the declared phase order`, {
    period,
    phaseOrder: [...phaseOrder],
  });
}

/**
 * Advance a stamp by a duration, **staying inside the named period** (§3.2).
 *
 * This is deliberate, not an oversight. A 2-minute minor awarded at 19:10 of a
 * 20-minute period nominally runs into the next period, but the engine cannot
 * compute that without a period-length table it does not require
 * (`periodSeconds` is optional, §1.3). Such a suspension simply does not expire
 * by time; it ends on an explicit end event, exactly as today. Promoting this
 * needs `periodSeconds` to become required — a product decision this wave does
 * not force.
 *
 * THROWS `INVALID_EVENT` for a negative or non-finite duration, rather than
 * coercing. This is the one place totality is the wrong trade. Flooring a
 * negative result at zero produced an `expiresAt` at the *period start*, which
 * the very next stamp sweeps as already expired — a penalty that silently never
 * runs, invisible in the state and invisible in a golden. And the claim of
 * totality was never true for `Infinity` anyway: `Math.trunc(Infinity)` is
 * `Infinity`, which `GameTime` rejects two layers later, far from the caller
 * that produced it. Nothing legitimately passes either: every caller is a
 * suspension length. A fractional duration is truncated — seconds are the
 * engine's only unit (§2).
 */
export function addDuration(at: GameTime, seconds: number): GameTime {
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new EngineError("INVALID_EVENT", `duration must be a non-negative finite number of seconds, got ${String(seconds)}`, {
      seconds,
      at,
    });
  }
  return { period: at.period, elapsed: at.elapsed + Math.trunc(seconds) };
}

/**
 * Seconds left in the period, floored at zero. Pad display only —
 * `periodSeconds` is a SOFT bound the fold never enforces (§1.3).
 */
export function remainingOf(at: GameTime, periodSeconds: number): number {
  return Math.max(0, Math.trunc(periodSeconds || 0) - at.elapsed);
}

/**
 * `761` → `"12:41"`. Minutes are unbounded — `7530` → `"125:30"`, never
 * `"2:05:30"` — because a scoresheet prints minutes of the period, and a period
 * that has run 125 minutes is a rain-delayed reality, not an hour reading. Only
 * seconds are zero-padded.
 */
export function formatElapsed(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest}`;
}

// mm:ss with the seconds field always two digits — "1:5" is ambiguous (five
// seconds? fifty?) and is rejected rather than guessed.
const MMSS = /^(\d+):([0-5]\d)$/;
const BARE = /^\d+$/;

/**
 * `"12:41" | "1:05" | "761"` → seconds; anything else → `null`. Never throws:
 * this is the manual-entry input path (§4), so junk is an expected input, not
 * an exceptional one.
 */
export function parseElapsed(text: string): number | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  const mmss = MMSS.exec(trimmed);
  if (mmss) {
    // Both groups are digit-only, so Number() cannot be NaN here.
    const seconds = Number(mmss[1]) * 60 + Number(mmss[2]);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  if (BARE.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  return null;
}

/**
 * Structural safe-parse of `payload.at` — the ONLY way core reads a stamp
 * (§1.4). Core learns no sport payload shapes: it asks whether this arbitrary
 * object happens to carry a `GameTime` under `at`, and gets `null` for
 * everything else, including every payload written before this wave.
 *
 * That `null` is what makes the wave additive. An unstamped event is
 * unconstrained by the monotonic guard, so no recorded stream changes meaning.
 */
export function gameTimeOf(payload: unknown): GameTime | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  if (!("at" in payload)) return null;
  const parsed = GameTime.safeParse((payload as { at: unknown }).at);
  return parsed.success ? parsed.data : null;
}
