// W4a follow-up — the PARTIAL set summary, on both seams it sits across.
//
// A `partial: true` summary is an in-progress snapshot of the OPEN set: the
// coarse analogue of a rally set that has not finished (spec 04 §9.6). Two
// defects lived here until the generator started producing one, because
// nothing else in the engine emitted a partial except `coarsen` itself:
//
//  §3.3 — `applySummary`'s "must not be a completed set score" refusal is a
//         projection of `setTo` / `finalSetTo` / `winBy` / `cap`, i.e. of CFG,
//         so it belongs on the write path only. Ungated it makes a recorded
//         snapshot unreadable the day the competition lowers the set length,
//         on every read, with no event to void.
//  §9.6 — `coarsen` flushed its own rally-derived partial AND passed the
//         incoming one through, putting two partials in the coarse stream for
//         one set. The coarse fold then reads a DECREASE (the flush restarts
//         at zero after a passed-through snapshot) and refuses the stream.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../../core/events.ts";
import { resolvePositions } from "../../sport/catalog.ts";
import type { ModuleEvent } from "../../sport/module.ts";
import { defaultLineupPair, makeEnvelope } from "../../testkit/helpers.ts";
import { badminton } from "./badminton.ts";
import type { SetBasedState } from "./kernel.ts";
import { tabletennis } from "./tabletennis.ts";
import { volleyball } from "./volleyball.ts";

const STRICT_ALL = { strictFromSeq: 0 } as const;

type Mod = typeof volleyball;

const MODULES = [badminton, tabletennis, volleyball] as Mod[];

const summaryType = (mod: Mod) =>
  `${mod.key}.${mod.key === "volleyball" ? "set.summary" : "game.summary"}`;

function envelopes(events: ModuleEvent[]): EventEnvelope[] {
  return events.map((event, i) => makeEnvelope(i, event));
}

function pairFor(mod: Mod, cfg: unknown) {
  return defaultLineupPair(resolvePositions(mod, cfg));
}

// The WRITE path: the whole stream is new, exactly as the pad builds it.
function record(mod: Mod, raw: unknown, events: ModuleEvent[]): EventEnvelope[] {
  const cfg = mod.configSchema.parse(raw);
  const envs = envelopes([{ type: "core.start", payload: {} }, ...events]);
  foldMatch(mod, cfg, pairFor(mod, cfg), envs, STRICT_ALL);
  return envs;
}

// The READ path: no options, so nothing is being validated — every event is
// already in the ledger.
function reread(mod: Mod, raw: unknown, envs: EventEnvelope[]): SetBasedState {
  const cfg = mod.configSchema.parse(raw);
  return foldMatch(mod, cfg, pairFor(mod, cfg), envs);
}

const rally = (mod: Mod, wonBy: string): ModuleEvent => ({
  type: `${mod.key}.rally`,
  payload: { wonBy },
});

// ---------------------------------------------------------------------------
// §3.3 — lowering the set length must not brick a recorded snapshot.
// ---------------------------------------------------------------------------
describe("a partial set summary survives a lowered set length (§3.3)", () => {
  it("re-reads a 15–3 volleyball snapshot after setTo drops to 11", () => {
    const type = summaryType(volleyball);
    const envs = record(volleyball, {}, [{ type, payload: { home: 15, away: 3, partial: true } }]);

    // 15–3 is an in-progress score at setTo 25 and a COMPLETED one at 11. The
    // organiser edit is legal; the fixture must still read.
    const state = reread(volleyball, { setTo: 11 }, envs);
    expect(state.sets[0]).toEqual({ home: 15, away: 3, closed: false });
    expect(volleyball.summary(state).headline).toContain("15");
  });

  it("still refuses a completed score as a snapshot on the WRITE path", () => {
    const type = summaryType(badminton);
    expect(() =>
      record(badminton, {}, [{ type, payload: { home: 21, away: 3, partial: true } }]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_EVENT" }));
  });
});

// ---------------------------------------------------------------------------
// §9.6 — coarsening a stream that already carries a snapshot.
// ---------------------------------------------------------------------------
describe("coarsen emits at most one partial per set (§9.6)", () => {
  for (const mod of MODULES) {
    const type = summaryType(mod);

    // The snapshot the pad writes: an entrant-keyed reading of the open set,
    // which coarsen can resolve without any lineup context.
    it(`${mod.key}: absorbs an entrant-keyed snapshot into the rally count`, () => {
      const cfg = mod.configSchema.parse({});
      const events: ModuleEvent[] = [];
      for (let i = 0; i < 3; i++) events.push(rally(mod, "H"));
      events.push(rally(mod, "A"));
      // Snapshot at 3–1, then the snapshot jumps the set on to 6–1: points the
      // scorer did not record rally by rally.
      events.push({ type, payload: { by: "H", forBy: 3, forOpp: 1, partial: true } });
      events.push({ type, payload: { by: "H", forBy: 6, forOpp: 1, partial: true } });
      for (let i = 0; i < 4; i++) events.push(rally(mod, "A"));

      const fine = record(mod, {}, events);
      const coarse = mod
        .coarsen!(fine as never)
        .map((event, i) => makeEnvelope(i, event));

      const partials = coarse.filter(
        (env) =>
          env.type === type && (env.payload as { partial?: boolean }).partial === true,
      );
      expect(partials.length, "one open set, one partial").toBe(1);

      const coarseState = foldMatch(
        mod,
        cfg,
        pairFor(mod, cfg),
        coarse,
        STRICT_ALL,
      );
      const fineState = foldMatch(mod, cfg, pairFor(mod, cfg), fine, STRICT_ALL);
      expect(coarseState.sets).toEqual(fineState.sets);
      expect(mod.summary(coarseState)).toEqual(mod.summary(fineState));
      expect(mod.outcome(coarseState)).toEqual(mod.outcome(fineState));
    });

    it(`${mod.key}: keeps a positional snapshot when it has no count of its own`, () => {
      const cfg = mod.configSchema.parse({});
      // A set recorded ONLY as a snapshot — no rallies for coarsen to segment.
      // Dropping it here would lose the set entirely, so it passes through.
      const fine = record(mod, {}, [{ type, payload: { home: 4, away: 2, partial: true } }]);
      const coarse = mod
        .coarsen!(fine as never)
        .map((event, i) => makeEnvelope(i, event));

      expect(coarse.map((env) => env.type)).toEqual(["core.start", type]);
      const coarseState = foldMatch(
        mod,
        cfg,
        pairFor(mod, cfg),
        coarse,
        STRICT_ALL,
      );
      const fineState = foldMatch(mod, cfg, pairFor(mod, cfg), fine, STRICT_ALL);
      expect(coarseState.sets).toEqual(fineState.sets);
      expect(mod.summary(coarseState)).toEqual(mod.summary(fineState));
    });

    it(`${mod.key}: keeps a positional snapshot out of a rally-scored set`, () => {
      const cfg = mod.configSchema.parse({});
      const events: ModuleEvent[] = [];
      for (let i = 0; i < 5; i++) events.push(rally(mod, "H"));
      events.push(rally(mod, "A"));
      // Positional {home, away}: coarsen has no lineup context by design, so it
      // cannot reconcile this with its own count — its rally-derived reading of
      // the set is the record, and this one is dropped rather than doubled up.
      events.push({ type, payload: { home: 5, away: 1, partial: true } });
      for (let i = 0; i < 3; i++) events.push(rally(mod, "A"));

      const fine = record(mod, {}, events);
      const coarse = mod
        .coarsen!(fine as never)
        .map((event, i) => makeEnvelope(i, event));

      const partials = coarse.filter(
        (env) =>
          env.type === type && (env.payload as { partial?: boolean }).partial === true,
      );
      expect(partials.length, "one open set, one partial").toBe(1);

      const coarseState = foldMatch(
        mod,
        cfg,
        pairFor(mod, cfg),
        coarse,
        STRICT_ALL,
      );
      const fineState = foldMatch(mod, cfg, pairFor(mod, cfg), fine, STRICT_ALL);
      expect(coarseState.sets).toEqual(fineState.sets);
      expect(mod.summary(coarseState)).toEqual(mod.summary(fineState));
    });
  }
});
