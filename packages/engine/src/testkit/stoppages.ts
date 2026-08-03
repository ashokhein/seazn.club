// Stoppage-bearing stream generator — W4 review item 5 (#407).
//
// WHY THIS EXISTS. `core.suspend` / `core.resume` are kernel-owned (spec 03 §2
// guarantee 5): `foldMatch` validates, folds and CONSUMES them, and they never
// reach `module.apply`. That is what let one implementation serve all eleven
// sports — and it is also why no module's `arbitraryEvent` can emit them:
// `buildStream` advances its state with `module.apply`, which rejects an event
// type the module has never heard of. So the generated corpus and every
// property suite built on it explored a world where play is never stopped, and
// guarantee 5's interaction with `decided` and `resolveVoids` was pinned only
// by hand-written cases.
//
// This generator injects the pair into a stream the module DID generate,
// choosing the injection point by folding prefixes so the suspension always
// lands on a live match. Kernel-owned means the injected events must leave the
// module's state untouched, which is the property the suite asserts.
//
// Purity note: no node:fs here, so this may be re-exported from the testkit
// barrel — unlike golden.ts and dossiers.ts.
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import { mulberry32 } from "../core/rng.ts";
import type { LineupPair } from "../core/types.ts";
import type { AnySportModule } from "../sport/module.ts";
import { makeEnvelope } from "./helpers.ts";

/** How a stream's stoppage is shaped.
 *  - `matched`      — suspend … resume, play continues. The common case.
 *  - `unresumed`    — suspended and never restarted (the match record ends
 *                     mid-stoppage: abandoned in fact, not yet in the ledger).
 *  - `orphan_resume`— a resume with no open stoppage. Reachable in the wild by
 *                     voiding a mis-entered suspend, so it must be a NO-OP and
 *                     not a refusal — otherwise undo makes a ledger unfoldable
 *                     (guarantee 3). */
export type StoppageMode = "matched" | "unresumed" | "orphan_resume";

export interface StoppageStream {
  /** The stream as recorded, stoppage events included. */
  events: EventEnvelope[];
  /** The same match with the stoppage events removed — the control. */
  plain: EventEnvelope[];
  /** Index into `plain` the stoppage was injected before. */
  at: number;
  /** Envelope id of the `core.suspend`, when the mode has one. */
  suspendId: string | null;
  /** The base stream's events from `at` onwards, which a live match would have
   *  gone on to record. Empty when the injection point is the end. */
  rest: EventEnvelope[];
}

/** Re-stamps seq and id so a spliced stream still reads like a real ledger. */
function renumber(events: readonly EventEnvelope[]): EventEnvelope[] {
  return events.map((event, i) => ({ ...event, seq: i, id: `e-${i}` }));
}

/** The last index of `base` at which the match is still undecided, so an
 *  injected suspend is refused by nothing but its own rules. Returns 0 (just
 *  after nothing) when even the first event decides. */
function liveInjectionPoint(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  base: readonly EventEnvelope[],
  rng: () => number,
): number {
  const live: number[] = [];
  for (let i = 1; i < base.length; i++) {
    const state = foldMatch(module, cfg, lineups, base.slice(0, i));
    if (module.outcome(state) === null) live.push(i);
  }
  if (live.length === 0) return 0;
  return live[Math.floor(rng() * live.length)] as number;
}

/** A generated stream with a stoppage spliced into it, or null when the base
 *  stream is too short to hold one (a module that decides on its first event). */
export function withStoppage(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  base: readonly EventEnvelope[],
  seed: number,
  mode: StoppageMode,
): StoppageStream | null {
  const rng = mulberry32(seed);
  const at = liveInjectionPoint(module, cfg, lineups, base, rng);
  if (at === 0) return null;

  const head = base.slice(0, at);
  const rest = base.slice(at);
  const suspend = makeEnvelope(at, {
    type: "core.suspend",
    payload: rng() < 0.5 ? { reason: "floodlight failure" } : {},
  });
  const resume = makeEnvelope(at + 1, { type: "core.resume", payload: {} });

  // `unresumed` truncates: everything after the suspend is play, and play
  // during a stoppage is exactly what guarantee 5 refuses.
  const events =
    mode === "matched"
      ? [...head, suspend, resume, ...rest]
      : mode === "unresumed"
        ? [...head, suspend]
        : [...head, resume, ...rest];

  return {
    events: renumber(events),
    plain: renumber(mode === "unresumed" ? head : base),
    at,
    suspendId: mode === "orphan_resume" ? null : `e-${at}`,
    rest: renumber(events).slice(mode === "matched" ? at + 2 : at + 1),
  };
}
