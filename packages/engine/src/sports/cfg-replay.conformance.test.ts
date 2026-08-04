// A CONFIG EDIT MUST NEVER MAKE A RECORDED FIXTURE UNREADABLE — W4a (#425) T9,
// across all eleven shipped modules.
//
// WHY THIS EXISTS. Two facts about this engine compose into a whole class of
// fixture-bricking bugs, and each looks harmless on its own:
//
//  1. `cfg` is NOT frozen with the stream. `append-event.ts` rebuilds it live
//     (`stageScopedCfg(division.config, stage?.config)`) on every call, so an
//     organiser editing a division's config changes the input to every past
//     fold.
//  2. Every READ replays from `init`. There is no incremental fold and no
//     cached partial state — the state route, the score page and standings all
//     run `foldMatch` over the whole stream.
//
// So any refusal computed from cfg fires on events ALREADY IN THE LEDGER the
// moment the config moves. There is no event to void (each one was legal when
// it was recorded) and no scorer action that recovers it: the fixture is
// permanently unviewable. Four instances were found and fixed by hand during
// this wave — nested's `interruptions[kind].count`, football's `sweepExpired`
// raising UNKNOWN_PHASE on a renamed period, nested's `bestOf` below the sets
// already banked, and the core phase guard itself. Finding them one at a time,
// in the sports somebody happened to be editing, is not a strategy.
//
// THE PROPERTY. Record a stream under a config. Fold it again under a MUTATED
// config — a lowered count, a shorter period, a disabled feature, a dropped
// optional block, a renamed label. Reading it must not throw. A config the
// stream no longer satisfies MAY change derived values (a flag flips, a
// projection moves); what it may never do is make history unreadable.
//
// NOT A REPLACEMENT for `time-kernel.conformance.test.ts`. That suite pins the
// six SEMANTICS of lazy suspension expiry for the three sports that have one,
// and needs a hand-written adapter per sport. This one asserts a single
// negative — "does not throw" — and so can be generic over all eleven with no
// per-sport code, which is exactly what is needed for a hazard whose whole
// character is that it appears in sports nobody is currently working on.
import { describe, expect, it } from "vitest";
import { foldMatch, type EventEnvelope } from "../core/events.ts";
import type { LineupPair } from "../core/types.ts";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { buildStream, defaultLineupPair, makeEnvelope } from "../testkit/helpers.ts";
import { builtinModules } from "./index.ts";

// ---------------------------------------------------------------------------
// Config mutation
// ---------------------------------------------------------------------------

type Path = (string | number)[];

interface Mutant {
  /** Human-readable: "periods.count 4 -> 1". Only used in failure output. */
  label: string;
  raw: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getAt(root: unknown, path: Path): unknown {
  let cursor: unknown = root;
  for (const key of path) cursor = (cursor as Record<string | number, unknown>)[key];
  return cursor;
}

/** Returns a copy with `path` set, or — when `value` is DROP — with the key
 *  removed. Removing is its own mutation: an optional cfg block that vanishes
 *  is the commonest edit an organiser makes, and it is not the same as setting
 *  the field to zero. */
const DROP = Symbol("drop");
function withAt(root: unknown, path: Path, value: unknown | typeof DROP): unknown {
  const copy = clone(root);
  let cursor = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  const last = path[path.length - 1] as string | number;
  if (value === DROP) {
    if (Array.isArray(cursor)) cursor.splice(last as number, 1);
    else delete cursor[last];
  } else {
    cursor[last] = value;
  }
  return copy;
}

/** Every leaf position in the parsed cfg, plus every container (so a whole
 *  optional block can be dropped, not only its scalars). */
function paths(value: unknown, base: Path = []): Path[] {
  if (base.length > 0 && !isPlainObject(value) && !Array.isArray(value)) return [base];
  const here: Path[] = base.length > 0 ? [base] : [];
  if (Array.isArray(value)) {
    return [...here, ...value.flatMap((item, i) => paths(item, [...base, i]))];
  }
  if (isPlainObject(value)) {
    return [...here, ...Object.entries(value).flatMap(([key, item]) => paths(item, [...base, key]))];
  }
  return here;
}

/**
 * The edits an organiser actually makes, applied at every position in the cfg.
 *
 * Deliberately NOT random. A seeded fuzzer over an unknown config shape would
 * spend most of its draws on values the schema rejects, and would make a red
 * run depend on the seed; these are enumerated, so the same mutant set is tried
 * every time and a failure names the exact edit.
 */
function mutantsFor(cfg: unknown): Mutant[] {
  const out: Mutant[] = [];
  const push = (path: Path, value: unknown | typeof DROP, how: string): void => {
    out.push({ label: `${path.join(".") || "<root>"} ${how}`, raw: withAt(cfg, path, value) });
  };
  for (const path of paths(cfg)) {
    const value = getAt(cfg, path);
    // Dropping is legal wherever the schema says optional; safeParse filters
    // the rest out below.
    push(path, DROP, "dropped");
    if (typeof value === "number" && Number.isFinite(value)) {
      // Lowered counts, reduced bestOf, shrunk period lengths — the three the
      // hand-found bugs all came from.
      for (const next of [value - 1, Math.floor(value / 2), 1, 0]) {
        if (next !== value && next >= 0) push(path, next, `${value} -> ${next}`);
      }
    } else if (typeof value === "boolean") {
      // Disabled features. `extraTime.enabled: false` deletes two football
      // phases and `shootout: false` a third, all at once.
      push(path, !value, `${value} -> ${!value}`);
    } else if (typeof value === "string") {
      // Renamed labels. Where a phase name lives in cfg this is the rename
      // that made football's sweep raise UNKNOWN_PHASE.
      push(path, `${value}-renamed`, "renamed");
    } else if (value === null) {
      // A nulled-out optional block (period/kernel's `overtime`) is how a
      // competition turns overtime off, and it deletes every OT phase.
      push(path, {}, "null -> {}");
    }
  }
  return out;
}

/** Only mutants the schema still accepts. A cfg the schema REJECTS is a
 *  different failure (CONFIG_INVALID at the boundary, before any fold), and
 *  asserting the fold survives it would be asserting the wrong thing. */
function parseableMutants(module: AnySportModule, cfg: unknown): { label: string; cfg: unknown }[] {
  const seen = new Set<string>([JSON.stringify(cfg)]);
  const out: { label: string; cfg: unknown }[] = [];
  for (const mutant of mutantsFor(cfg)) {
    const parsed = module.configSchema.safeParse(mutant.raw);
    if (!parsed.success) continue;
    const fingerprint = JSON.stringify(parsed.data);
    if (seen.has(fingerprint)) continue; // a no-op edit proves nothing
    seen.add(fingerprint);
    out.push({ label: mutant.label, cfg: parsed.data });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Recorded streams
// ---------------------------------------------------------------------------

// Football's default is a league fixture — no extra time, no shootout — so no
// mutant of it can DELETE a phase, and the sport's sharpest case would go
// untested. Same hand-picked config the golden corpus carries for the same
// reason.
const EXTRA_CONFIGS: Record<string, Record<string, unknown>> = {
  football: {
    knockout: { extraTime: { enabled: true, halfMinutes: 15 }, shootout: true },
  },
};

const SEEDS = [1, 2, 7];
const MAX_EVENTS = 30;

function rawConfigsFor(module: AnySportModule): [string, unknown][] {
  const candidates: [string, unknown][] = [
    ["default", {}],
    ...Object.entries(EXTRA_CONFIGS[module.key] ?? {}),
    ...Object.entries(module.variants as Record<string, unknown>),
  ];
  const out: [string, unknown][] = [];
  const seen = new Set<string>();
  for (const [name, raw] of candidates) {
    const parsed = module.configSchema.safeParse(raw);
    if (!parsed.success) continue; // generic has no valid empty config
    const fingerprint = JSON.stringify(parsed.data);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push([name, parsed.data]);
    if (out.length >= 3) break;
  }
  return out;
}

interface Recorded {
  events: EventEnvelope[];
  /** The phase the injected stoppage is stamped in, when one was injectable. */
  stampedIn: string | null;
}

/**
 * A stream as the LEDGER would hold it — every event validated on the way in.
 *
 * The strict fold is the premise, not a convenience: the property only means
 * something for a stream the write gate would actually have accepted, and
 * `buildStream` advances with `module.apply` alone, which is one layer short of
 * the kernel's own guards.
 *
 * A STAMPED core.suspend / core.resume pair is spliced on where the module
 * declares its phases. That is the only way to reach the game-time guards for
 * eight of the eleven sports: the stoppage pair is kernel-owned, so no module's
 * `arbitraryEvent` can emit it, and most sports' own payloads carry no `at`.
 * Without it this property would exercise the allowance-shaped hazards and
 * silently skip the phase-shaped ones — the failure mode the wave has already
 * been bitten by twice.
 */
function renumber(events: readonly EventEnvelope[]): EventEnvelope[] {
  return events.map((event, i) => ({ ...event, seq: i, id: `e-${i}` }));
}

/** The stamp of the last stamped event in `head`, or null. An EQUAL stamp is
 *  legal (§1.2 — a suspend and its resume share one), so reusing it is the one
 *  choice that can never be backwards against what follows. */
function lastStamp(head: readonly EventEnvelope[]): { period: string; elapsed: number } | null {
  for (let i = head.length - 1; i >= 0; i--) {
    const at = (head[i] as EventEnvelope).payload as { at?: { period?: unknown; elapsed?: unknown } };
    const stamp = at?.at;
    if (typeof stamp?.period === "string" && typeof stamp.elapsed === "number") {
      return { period: stamp.period, elapsed: stamp.elapsed };
    }
  }
  return null;
}

function record(
  module: AnySportModule,
  cfg: unknown,
  lineups: LineupPair,
  seed: number,
): Recorded | null {
  const base = buildStream(module, cfg, lineups, seed, MAX_EVENTS);
  if (base.length === 0) return null;

  const strict = { strictFromSeq: 0 };
  const phases = module.playPhases?.(cfg) ?? [];
  // Spliced at a LIVE point, not appended. A generated stream usually ends
  // decided, and a suspend after the final whistle is ALREADY_DECIDED — which
  // silently left football, ice hockey and hockey with no stamp at all on the
  // first cut of this suite, i.e. green on the half of the property they exist
  // to exercise.
  for (let atIndex = base.length - 1; atIndex >= 1 && phases.length > 0; atIndex--) {
    const head = base.slice(0, atIndex);
    const at = lastStamp(head) ?? { period: phases[0] as string, elapsed: 0 };
    const events = renumber([
      ...head,
      makeEnvelope(0, { type: "core.suspend", payload: { reason: "rain", at } }),
      makeEnvelope(0, { type: "core.resume", payload: { at } }),
      ...base.slice(atIndex),
    ]);
    try {
      foldMatch(module, cfg, lineups, events, strict);
      return { events, stampedIn: at.period };
    } catch {
      continue; // this match was already over here, or the module refuses the pause
    }
  }
  try {
    foldMatch(module, cfg, lineups, base, strict);
  } catch {
    return null; // the generator produced something the kernel refuses; not our subject
  }
  return { events: base, stampedIn: null };
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

/**
 * THE ONE CLASS THIS SUITE DOES NOT YET ASSERT AWAY, named rather than skipped.
 *
 * Lowering `bestOf`, `maxBoards`, `periods.count` or cricket's `playersPerSide`
 * makes a recorded match DECIDE EARLIER on replay than it decided when it was
 * scored. Guarantee 4 then refuses every event the ledger legitimately holds
 * after that point (`ALREADY_DECIDED`), and where the kernel lets one through
 * the module refuses it itself once its state reaches a terminal phase.
 *
 * NOT FIXED HERE, deliberately. Gating guarantee 4 on the seam was tried and
 * reverted: it moves the throw one layer down into every module's own
 * `"done"`-phase guard, so a real fix is a coordinated decision across the
 * kernel and all eleven modules about what a post-decision event even MEANS on
 * replay — dispatch it and the state is nonsense, skip it and the fold silently
 * drops recorded history. That is a ruling, not a T9 call, and half of it is
 * worse than none.
 *
 * The carve-out is written as an exhaustive classification, not a filter: every
 * failure must fall in this class, so a NEW way to brick a fixture reds the
 * suite the moment it lands. And `SPORTS_WITH_DECIDED_EARLIER` is asserted
 * EXACTLY, so fixing it also reds — which is the point. When that happens,
 * delete the carve-out rather than editing the list.
 */
function isDecidedEarlier(code: string, message: string): boolean {
  return (
    code === "ALREADY_DECIDED" ||
    (code === "WRONG_PHASE" &&
      /not allowed in phase "(done|final|FT|SHOOTOUT)"|match already over/.test(message))
  );
}

const SPORTS_WITH_DECIDED_EARLIER = [
  "carrom",
  "cricket",
  "hockey",
  "icehockey",
  "tabletennis",
  "tennis",
  "volleyball",
  "badminton",
].sort();

describe("a config edit never makes a recorded fixture unreadable (§3.3)", () => {
  describe.each(builtinModules.map((module) => [module.key, module] as const))(
    "%s",
    (_key, module) => {
      const configs = rawConfigsFor(module);

      it("re-reads every recorded stream under every parseable config edit", () => {
        const failures: string[] = [];
        let folds = 0;

        for (const [configName, cfg] of configs) {
          const lineups = defaultLineupPair(resolvePositions(module, cfg));
          const mutants = parseableMutants(module, cfg);
          for (const seed of SEEDS) {
            const recorded = record(module, cfg, lineups, seed);
            if (recorded === null) continue;
            for (const mutant of mutants) {
              folds++;
              try {
                // THE READ PATH: no options, so nothing in this fold is being
                // validated — every event is already in the ledger.
                foldMatch(module, mutant.cfg, lineups, recorded.events);
              } catch (err) {
                const code = (err as { code?: string }).code ?? "?";
                const message = (err as Error).message;
                if (isDecidedEarlier(code, message)) continue; // filed, see above
                failures.push(
                  `${configName}/seed ${seed}${recorded.stampedIn === null ? "" : ` (stamped in ${recorded.stampedIn})`}` +
                    ` × [${mutant.label}] -> ${code}: ${message}`,
                );
              }
            }
          }
        }

        // A property that ran zero folds is a green that means nothing.
        expect(folds, `${module.key}: no cfg mutant was exercised at all`).toBeGreaterThan(0);
        // De-duplicated and capped: one broken check repeats across dozens of
        // mutants, and the first few are what triages it.
        expect([...new Set(failures)].sort().slice(0, 10)).toEqual([]);
      });

      it("has a config edit that actually moves the phase list, where it declares one", () => {
        // THE ANTI-VACUOUS CHECK. The phase-shaped half of the hazard is only
        // reachable if some mutant changes `playPhases`. Without this, a module
        // whose phases happen not to be cfg-derived under these configs would
        // report green on a property it never ran — the same shape as a
        // generator that cannot produce its own counterexample.
        if (module.playPhases === undefined) return;
        const moved = configs.some(([, cfg]) => {
          const before = JSON.stringify(module.playPhases?.(cfg));
          return parseableMutants(module, cfg).some(
            (mutant) => JSON.stringify(module.playPhases?.(mutant.cfg)) !== before,
          );
        });
        expect(moved, `${module.key}: no parseable cfg edit changes playPhases`).toBe(true);
      });
    },
  );

  it("still exhibits the filed decided-earlier class in exactly these sports", () => {
    // A carve-out nobody can see is a carve-out nobody removes. This asserts
    // the EXACT set, so the day someone rules on what a post-decision event
    // means on replay and fixes it, this reds and points at `isDecidedEarlier`
    // — delete the carve-out, do not edit the list.
    const exhibits = new Set<string>();
    for (const module of builtinModules) {
      for (const [, cfg] of rawConfigsFor(module)) {
        const lineups = defaultLineupPair(resolvePositions(module, cfg));
        for (const seed of SEEDS) {
          const recorded = record(module, cfg, lineups, seed);
          if (recorded === null) continue;
          for (const mutant of parseableMutants(module, cfg)) {
            try {
              foldMatch(module, mutant.cfg, lineups, recorded.events);
            } catch (err) {
              if (isDecidedEarlier((err as { code?: string }).code ?? "?", (err as Error).message)) {
                exhibits.add(module.key);
              }
            }
          }
        }
      }
    }
    expect([...exhibits].sort()).toEqual(SPORTS_WITH_DECIDED_EARLIER);
  });

  it("reaches the game-time guards in every module that declares phases", () => {
    // Companion to the per-module check above: the mutants move the phase list,
    // AND the recorded streams carry a stamp for it to bite. Asserted once,
    // across the eleven, so a module that silently stops being stampable shows
    // up here rather than as a quietly weaker suite.
    const missing: string[] = [];
    for (const module of builtinModules) {
      if (module.playPhases === undefined) continue;
      const stamped = rawConfigsFor(module).some(([, cfg]) => {
        const lineups = defaultLineupPair(resolvePositions(module, cfg));
        return SEEDS.some((seed) => record(module, cfg, lineups, seed)?.stampedIn != null);
      });
      if (!stamped) missing.push(module.key);
    }
    expect(missing).toEqual([]);
  });
});
