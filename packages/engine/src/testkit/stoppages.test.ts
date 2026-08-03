// Generated coverage for fold guarantee 5 — W4 review item 5 (#407).
//
// `core.suspend` / `core.resume` shipped with hand-written cases only: no
// module's `arbitraryEvent` can emit them (they never reach `module.apply`, so
// `buildStream` cannot advance its state past one), which left them out of
// every generated stream and out of the golden corpus. Guarantee 5 interacts
// with `decided` and with `resolveVoids`, and neither interaction was explored
// by anything a seed could reproduce.
//
// So: splice the pair into streams the modules DID generate, across all eleven
// builtins and many seeds, and assert what "kernel-owned" is supposed to mean.
// The two shapes the review named explicitly — a suspend that is never
// resumed, and a resume with no matching suspend — are first-class modes.
import { describe, expect, it } from "vitest";
import { EngineError } from "../core/errors.ts";
import {
  foldMatch,
  foldMatchWithStoppage,
  resolveVoids,
} from "../core/events.ts";
import type { EventEnvelope } from "../core/events.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { builtinModules } from "../sports/index.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "./helpers.ts";
import { SIM_CONFIGS } from "./simulation.ts";
import {
  withStoppage,
  type StoppageMode,
  type StoppageStream,
} from "./stoppages.ts";

// Mirrors the kernel's own list (core/events.ts): what a suspended ledger
// still accepts. Anything outside it claims play happened while play was
// stopped, and must be refused.
const DURING_STOPPAGE = [
  "core.resume",
  "core.note",
  "core.award",
  "core.abandon",
  "core.forfeit",
  "core.finalize",
];

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];
const MAX_EVENTS = 30;

interface Case {
  module: AnySportModule;
  cfg: unknown;
  lineups: ReturnType<typeof defaultLineupPair>;
  seed: number;
  stream: StoppageStream;
}

/** Every (module, seed) whose generated stream is long enough to hold a
 *  stoppage, for one mode. Modules that decide on their first event (generic,
 *  boardgame on most seeds) contribute nothing and are allowed to. */
function casesFor(mode: StoppageMode): Case[] {
  const out: Case[] = [];
  for (const module of builtinModules) {
    const cfg = module.configSchema.parse(SIM_CONFIGS[module.key] ?? {});
    const lineups = defaultLineupPair(resolvePositions(module, cfg));
    for (const seed of SEEDS) {
      const base = buildStream(module, cfg, lineups, seed, MAX_EVENTS);
      const stream = withStoppage(module, cfg, lineups, base, seed, mode);
      if (stream !== null) out.push({ module, cfg, lineups, seed, stream });
    }
  }
  return out;
}

const fold = (c: Case, events: readonly EventEnvelope[]) =>
  foldMatch(c.module, c.cfg, c.lineups, events);
const foldStop = (c: Case, events: readonly EventEnvelope[]) =>
  foldMatchWithStoppage(c.module, c.cfg, c.lineups, events);

const label = (c: Case) => `${c.module.key} seed=${c.seed}`;

/** The two events that are legal DURING a stoppage and also decide the match.
 *  A forfeit needs a side; the home entrant is always in the lineup pair. */
const enders = (c: Case) => [
  { type: "core.abandon", payload: { reason: "storm" } },
  {
    type: "core.forfeit",
    payload: { by: c.lineups.home.entrantId, reason: "walkover" },
  },
];

describe("generated stoppages — fold guarantee 5", () => {
  const matched = casesFor("matched");
  const unresumed = casesFor("unresumed");
  const orphan = casesFor("orphan_resume");

  it("reaches every builtin module, so no sport is silently exempt", () => {
    const covered = [...new Set(matched.map((c) => c.module.key))].sort();
    expect(covered, `covered: ${covered.join(",")}`).toEqual(
      builtinModules.map((m) => m.key).sort(),
    );
    expect(matched.length).toBeGreaterThan(40);
  });

  it("leaves the module's state untouched — a suspension is not play", () => {
    for (const c of matched) {
      expect(fold(c, c.stream.events), label(c)).toEqual(
        fold(c, c.stream.plain),
      );
    }
  });

  it("closes the stoppage on resume, so a resumed match is not 'suspended'", () => {
    for (const c of matched) {
      expect(foldStop(c, c.stream.events).stoppage, label(c)).toBeNull();
    }
  });

  it("reports the open stoppage when play never restarted", () => {
    for (const c of unresumed) {
      const { state, stoppage } = foldStop(c, c.stream.events);
      expect(stoppage?.eventId, label(c)).toBe(c.stream.suspendId);
      // The suspend itself moved nothing: the state is the head's state.
      expect(state, label(c)).toEqual(fold(c, c.stream.plain));
    }
  });

  it("refuses the next real event while play is suspended", () => {
    let checked = 0;
    for (const c of unresumed) {
      // The event the base stream would have recorded next, re-stamped to sit
      // after the suspend.
      const base = buildStream(c.module, c.cfg, c.lineups, c.seed, MAX_EVENTS);
      const next = base[c.stream.at];
      // Skip the types guarantee 5 deliberately ALLOWS mid-stoppage — an
      // annotation or an event that ends the stoppage is not "play".
      if (next === undefined || DURING_STOPPAGE.includes(next.type)) continue;
      const after = [
        ...c.stream.events,
        makeEnvelope(c.stream.events.length, {
          type: next.type,
          payload: next.payload,
        }),
      ];
      try {
        foldStop(c, after);
        expect.unreachable(
          `${label(c)} accepted "${next.type}" during a stoppage`,
        );
      } catch (error) {
        expect(
          EngineError.is(error, "WRONG_PHASE"),
          `${label(c)} ${String(error)}`,
        ).toBe(true);
      }
      checked += 1;
    }
    expect(checked, "cases with a next event to refuse").toBeGreaterThan(30);
  });

  it("treats a resume with no matching suspend as a no-op, never a refusal", () => {
    for (const c of orphan) {
      expect(fold(c, c.stream.events), label(c)).toEqual(
        fold(c, c.stream.plain),
      );
      expect(foldStop(c, c.stream.events).stoppage, label(c)).toBeNull();
    }
  });

  it("keeps the ledger foldable when the suspend is voided (guarantee 3)", () => {
    for (const c of unresumed) {
      const voided = [
        ...c.stream.events,
        makeEnvelope(
          c.stream.events.length,
          { type: "core.void", payload: {} },
          c.stream.suspendId as string,
        ),
      ];
      // resolveVoids strips the suspend AND the void before the kernel folds.
      expect(
        resolveVoids(voided).some((e) => e.type === "core.suspend"),
        label(c),
      ).toBe(false);
      const { state, stoppage } = foldStop(c, voided);
      expect(stoppage, `${label(c)} stoppage survived the undo`).toBeNull();
      expect(state, label(c)).toEqual(fold(c, c.stream.plain));
    }
  });

  it("clears the stoppage when the match decides mid-suspension", () => {
    // core.abandon and core.forfeit are both legal during a stoppage and both
    // decide. A decided match is not awaiting a restart — and core.resume is
    // not a post-decision type, so a stoppage left open here could never be
    // cleared again.
    let checked = 0;
    for (const c of unresumed) {
      for (const ender of enders(c)) {
        const abandoned = [
          ...c.stream.events,
          makeEnvelope(c.stream.events.length, ender),
        ];
        let result;
        try {
          result = foldStop(c, abandoned);
        } catch (error) {
          // A module may refuse an abandon or a forfeit in its own phase; that
          // is its call, and it is still a typed refusal, never a crash.
          expect(EngineError.is(error), `${label(c)} ${String(error)}`).toBe(
            true,
          );
          continue;
        }
        // `abandonPolicy: "replay"` leaves the fixture UNDECIDED on purpose, so
        // there is nothing for the stoppage to have outlived: the match is still
        // live and can still be resumed. The guarantee is about the step that
        // flips `decided`.
        if (c.module.outcome(result.state as never) === null) continue;
        expect(
          result.stoppage,
          `${label(c)} stoppage outlived ${ender.type}`,
        ).toBeNull();
        checked += 1;
      }
    }
    expect(checked, "cases that reached an abandon").toBeGreaterThan(30);
  });
});
