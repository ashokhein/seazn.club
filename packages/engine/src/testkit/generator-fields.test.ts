// W4a (#425) T10 follow-up — the GENERATOR half of the field-coverage gate.
//
// `golden.test.ts` asks whether the frozen CORPUS writes every optional field a
// module declares. It cannot ask the prior question: could the module's own
// `arbitraryEvent` ever produce one? Twenty entries on `UNREACHABLE_FIELDS`
// answered "no" for fields whose payload branch declares them and whose
// generator simply never set them — a coverage gap wearing an exemption's
// clothes. No property run explored them, no appended golden stream could
// contain one, and narrowing or renaming any of them reddened nothing.
//
// Those twenty are closed in the generators under `src/sports/**`. This file is
// what keeps them closed, and it pins four things per field:
//
//  1. DECLARED — checked against `declaredOptionalFields`, the module's own
//     event union, so a rename or a reshape reds HERE instead of quietly
//     turning the case below into an assertion about a key nothing declares.
//  2. WRITTEN — some generated event of the named type carries it.
//  3. SOMETIMES — some other generated event of that SAME type, with the
//     parent object present, does NOT carry it. A field set on every event is
//     as blind as one never set: the missing-field fold path stops being
//     walked, coarse-equals-fine stops being tested against both shapes, and
//     the appended golden streams all agree with each other. Scoping the
//     absence to the same event type (and to payloads that DO have the parent)
//     is what stops this half from passing vacuously — a football card trivially
//     has no `assist`, and a delivery with no wicket trivially has no
//     `wicket.incoming`.
//  4. NOT EXEMPTED — the `UNREACHABLE_FIELDS` entry is gone.
//
// `buildStream` APPLIES every event it generates, so a generator that starts
// emitting something its own fold rejects throws right here rather than
// reddening a conformance run somewhere downstream for the wrong reason.
import { describe, expect, it } from "vitest";
import { resolvePositions } from "../sport/catalog.ts";
import type { AnySportModule } from "../sport/module.ts";
import { badminton } from "../sports/setbased/badminton.ts";
import { carrom } from "../sports/carrom/index.ts";
import { cricket } from "../sports/cricket/index.ts";
import { football } from "../sports/football/index.ts";
import { hockey } from "../sports/hockey/index.ts";
import { icehockey } from "../sports/icehockey/index.ts";
import { tabletennis } from "../sports/setbased/tabletennis.ts";
import { tennis } from "../sports/tennis/index.ts";
import { volleyball } from "../sports/setbased/volleyball.ts";
import { UNREACHABLE_FIELDS, declaredOptionalFields } from "./golden.ts";
import { buildStream, defaultLineupPair } from "./helpers.ts";
import { fieldPresent } from "./schema-fields.ts";

interface Probe {
  /** The event type whose payload branch declares the field. */
  type: string;
  /** Dotted optional path, exactly as `declaredOptionalFields` reports it. */
  path: string;
}

interface GeneratorCase {
  module: AnySportModule;
  /** `variants` key, or "default" for the module's empty config. */
  config: string;
  /** Seeds 1..seeds are walked; enough that both branches of every probe land. */
  seeds: number;
  /** Stream length, when the default is not enough to SAMPLE the probe. Cricket
   *  needs it: a review sits in a 0.6%-wide band of the roll, so 80 events a
   *  seed yielded four in the whole walk and "sometimes, not always" turned on
   *  a coin landing the same way four times. Reaching further into the match is
   *  a sampling budget, not a change to what the generator does. */
  maxEvents?: number;
  probes: Probe[];
}

/** Long enough to reach a shoot-out and a second innings; MAX_EVENTS (40) is
 *  the recording cap, not a property of the generator. */
const MAX_EVENTS = 80;

const CASES: GeneratorCase[] = [
  {
    module: football,
    config: "default",
    seeds: 40,
    probes: [
      { type: "football.goal", path: "assist" },
      { type: "football.goal", path: "penalty" },
      { type: "football.period", path: "addedMinutes" },
    ],
  },
  {
    module: carrom,
    config: "default",
    seeds: 40,
    probes: [{ type: "carrom.game.adjust", path: "offendingEntrantId" }],
  },
  {
    module: tennis,
    config: "default",
    seeds: 20,
    probes: [{ type: "tennis.point", path: "meta.receiverSide" }],
  },
  {
    module: icehockey,
    config: "default",
    seeds: 40,
    probes: [
      { type: "icehockey.shootout.attempt", path: "meta" },
      { type: "icehockey.shootout.attempt", path: "meta.clockSeconds" },
      { type: "icehockey.shootout.attempt", path: "meta.ineligible" },
      { type: "icehockey.goal", path: "period" },
    ],
  },
  // Cricket's four, all under a limited-overs variant: `revise` needs a quota
  // and a single innings per side, and the coarse-innings path only reaches a
  // `partial` where an innings has a limit to be partial against.
  {
    module: cricket,
    config: "t20",
    seeds: 60,
    maxEvents: 400,
    probes: [
      { type: "cricket.ball", path: "wicket.incoming" },
      { type: "cricket.review", path: "against" },
      { type: "cricket.revise", path: "target" },
      { type: "cricket.innings.summary", path: "partial" },
    ],
  },
  // The set-based trio share one kernel and one generator, but each has its own
  // preset, so each is walked on its own.
  {
    module: badminton,
    config: "default",
    seeds: 20,
    probes: [{ type: "badminton.game.summary", path: "partial" }],
  },
  {
    module: tabletennis,
    config: "default",
    seeds: 20,
    probes: [{ type: "tabletennis.game.summary", path: "partial" }],
  },
  {
    module: volleyball,
    config: "default",
    seeds: 20,
    probes: [{ type: "volleyball.set.summary", path: "partial" }],
  },
  // Hockey's default and `fih-outdoor` have no shoot-out at all, so the attempt
  // is only generated under the variant that declares one. `goalKinds` and the
  // goal payload are the same under every hockey variant.
  {
    module: hockey,
    config: "fih-shootout",
    seeds: 40,
    probes: [
      { type: "hockey.shootout.attempt", path: "meta" },
      { type: "hockey.shootout.attempt", path: "meta.clockSeconds" },
      { type: "hockey.shootout.attempt", path: "meta.ineligible" },
      { type: "hockey.goal", path: "period" },
    ],
  },
];

/** Every payload the generator emits for `type`, across seeds 1..seeds. */
function generatedPayloads(testCase: GeneratorCase): Map<string, unknown[]> {
  const raw =
    testCase.config === "default"
      ? {}
      : (testCase.module.variants as Record<string, unknown>)[testCase.config];
  if (raw === undefined) {
    throw new Error(`${testCase.module.key} declares no variant "${testCase.config}"`);
  }
  const cfg = testCase.module.configSchema.parse(raw);
  const lineups = defaultLineupPair(resolvePositions(testCase.module, cfg));
  const byType = new Map<string, unknown[]>();
  const length = testCase.maxEvents ?? MAX_EVENTS;
  for (let seed = 1; seed <= testCase.seeds; seed++) {
    for (const envelope of buildStream(testCase.module, cfg, lineups, seed, length)) {
      const bucket = byType.get(envelope.type);
      if (bucket === undefined) byType.set(envelope.type, [envelope.payload]);
      else bucket.push(envelope.payload);
    }
  }
  return byType;
}

/** The object a leaf hangs off — "" for a top-level field, which is always
 *  "present". Absence of `meta.clockSeconds` only counts as a recorded ABSENCE
 *  when `meta` itself was written; otherwise every attempt without a `meta`
 *  would satisfy it and the "sometimes" half would prove nothing. */
function parentOf(path: string): string {
  const cut = path.lastIndexOf(".");
  return cut === -1 ? "" : path.slice(0, cut);
}

describe("arbitraryEvent writes the optional fields its payload branches declare", () => {
  for (const testCase of CASES) {
    const { module, config, probes } = testCase;
    describe(`${module.key} (${config})`, () => {
      // One walk per module — cricket's is ~90k events and every probe reads it.
      const payloadsByType = generatedPayloads(testCase);

      for (const { type, path } of probes) {
        describe(`${type}.${path}`, () => {
          it("is an optional field the module's own event union declares", () => {
            expect(
              declaredOptionalFields(module),
              `${module.key} no longer declares "${path}" optional — this case is now ` +
                `asserting against a key nothing in the union has, which passes for free`,
            ).toContain(path);
          });

          it("is written by some generated event of that type", () => {
            const payloads = payloadsByType.get(type) ?? [];
            expect(payloads.length, `${module.key} generated no ${type} at all`).toBeGreaterThan(0);
            expect(
              payloads.filter((payload) => fieldPresent(payload, path)).length,
              `${module.key}: not one of ${payloads.length} generated ${type} payloads writes ` +
                `"${path}", so no property run and no appended golden stream can ever hold one`,
            ).toBeGreaterThan(0);
          });

          it("is ABSENT from some generated event of that type — sometimes, not always", () => {
            const parent = parentOf(path);
            const payloads = (payloadsByType.get(type) ?? []).filter(
              (payload) => parent === "" || fieldPresent(payload, parent),
            );
            expect(
              payloads.filter((payload) => !fieldPresent(payload, path)).length,
              `${module.key}: EVERY generated ${type} that has "${parent || "a payload"}" also ` +
                `writes "${path}". A field set on every event never exercises the ` +
                `missing-field fold path, and every generated stream agrees with every other`,
            ).toBeGreaterThan(0);
          });

          it("is no longer allow-listed as unreachable", () => {
            expect(
              Object.keys(UNREACHABLE_FIELDS[module.key] ?? {}),
              `${module.key}.${path} is generated now — its UNREACHABLE_FIELDS entry reads as ` +
                `a considered exemption while suppressing a field the generator writes`,
            ).not.toContain(path);
          });
        });
      }
    });
  }
});

// ------------------------------------------------- the two classes, kept apart
//
// GENERATOR means "the branch declares it, arbitraryEvent never sets it" — a
// coverage gap, and the whole subject of this file. KERNEL-UNION means the
// shared set-based union over-declares for a sport whose `records` preset
// cannot register the owning event type at all, and `apply` refuses it BY NAME;
// `records` is a compile-time preset, so no config and no seed reaches those.
// Collapsing the two is how a real gap gets filed under a legitimate exemption
// and stops being looked at.
//
// NONE survive. Seven did until the W4a follow-up: each was blocked on a fold
// defect the generator change merely EXPOSED — two cfg-derived refusals that
// fired on the READ path (§3.3) and a coarsener that emitted two partials for
// one set (§9.6). Fixing those three is what let the last seven close, so the
// list is empty rather than deleted: it is asserted as an EXACT set, and an
// eighth entry appearing reds here with the reason attached.
const BLOCKED_GENERATOR_FIELDS: string[] = [];

describe("UNREACHABLE_FIELDS keeps its GENERATOR and KERNEL-UNION classes apart", () => {
  const entriesOfClass = (prefix: string): string[] =>
    Object.entries(UNREACHABLE_FIELDS)
      .flatMap(([key, entries]) =>
        Object.entries(entries)
          .filter(([, reason]) => reason.startsWith(prefix))
          .map(([path]) => `${key}.${path}`),
      )
      .sort();

  it("holds exactly the filed GENERATOR gaps and no others", () => {
    expect(
      entriesOfClass("GENERATOR"),
      `a GENERATOR entry is a coverage gap, not an exemption. A NEW one means a field ` +
        `slipped past the generator: widen the sport's own arbitraryEvent so it is written ` +
        `on SOME events, or — if it is genuinely cfg-gated — add a COVERAGE_CONFIGS entry. ` +
        `A MISSING one means a gap was closed: delete the line, do not edit this list`,
    ).toEqual(BLOCKED_GENERATOR_FIELDS);
  });

  it("states the blocker on every surviving GENERATOR entry", () => {
    // The whole point of the class is that it is temporary. An entry that says
    // only "the generator never sets it" is a restatement of the gate's own
    // finding; one that names what closing it would break is a decision.
    for (const [key, entries] of Object.entries(UNREACHABLE_FIELDS)) {
      for (const [path, reason] of Object.entries(entries)) {
        if (!reason.startsWith("GENERATOR")) continue;
        expect(reason, `${key}.${path}`).toContain("(BLOCKED)");
      }
    }
  });

  it("classes every remaining entry as one of the two, never something new", () => {
    const classed = new Set([...entriesOfClass("GENERATOR"), ...entriesOfClass("KERNEL-UNION")]);
    const all = Object.entries(UNREACHABLE_FIELDS).flatMap(([key, entries]) =>
      Object.keys(entries).map((path) => `${key}.${path}`),
    );
    expect(all.filter((entry) => !classed.has(entry)).sort()).toEqual([]);
  });
});
