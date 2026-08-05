// Scheduling constraints v2 (Jul3/04 §3) — the richer constraint family the
// calendar pass honours. Times inside the engine are epoch ms (injected); the
// API layer converts ISO strings. Zod schema first (PROMPT-00 §3).
import { z } from "zod";

export const StartWindowTarget = z.object({
  kind: z.enum(["entrant", "pool", "division"]),
  id: z.string(),
});
export type StartWindowTarget = z.infer<typeof StartWindowTarget>;

export const StartWindow = z.object({
  target: StartWindowTarget,
  notBefore: z.number().optional(), // epoch ms lower bound (14 Apr, 10 May)
  notAfter: z.number().optional(), // epoch ms upper bound on the START
});
export type StartWindow = z.infer<typeof StartWindow>;

// --- Typed instruction constraints (#398) ----------------------------------
// The compiled form of an organiser's free-text instruction. Deliberately
// UNIT-FREE: minutes, counts, weekdays, YYYY-MM-DD and HH:mm only. The one
// timestamped thing an instruction can say — its calendar window — is resolved
// into `pack.window` instead, which the verifier already checks, so this union
// needs no ISO/epoch conversion at any edge and the engine and the pack share
// one type rather than two families that can drift apart.

export const WeekdayCode = z.enum(["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"]);
export type WeekdayCode = z.infer<typeof WeekdayCode>;

export const ConstraintScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("competition") }),
  z.object({ kind: z.literal("division"), divisionId: z.string().min(1) }),
  z.object({ kind: z.literal("entrant"), entrantId: z.string().min(1) }),
  z.object({ kind: z.literal("person"), personKey: z.string().min(1) }),
  z.object({ kind: z.literal("pool"), divisionId: z.string().min(1), pool: z.string().min(1) }),
]);
export type ConstraintScope = z.infer<typeof ConstraintScope>;

/** NO `round` member, on purpose. Round numbers are DISPLAY LABELS: an
 *  elimination bracket numbers sparsely (1,2,3 winners / 7-10 losers / 14 grand
 *  final) and a rule keyed on one would silently address the wrong fixtures.
 *  `terminal` means `feeds.winner_to === null`, resolved per division in scope —
 *  never a round number, never a naming convention. */
export const FixtureSelector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal") }),
  z.object({
    kind: z.literal("ext_key"),
    extKey: z.string().min(1),
    divisionId: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("id"), fixtureId: z.string().min(1) }),
]);
export type FixtureSelector = z.infer<typeof FixtureSelector>;

const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Wall-clock time in the ORG zone, never an instant — see the unit note above.
 *  A field that accepted "either ISO or HH:mm" is exactly the silently-compare-
 *  the-wrong-unit trap `verifyConfig` already refuses for startWindows. */
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const HardConstraint = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("min_rest_minutes"),
    minutes: z.number().int().positive(),
    rest_scope: z.enum(["per_person", "feeder_to_dependent", "both"]),
    scope: ConstraintScope,
  }),
  z.object({
    type: z.literal("max_fixtures_per_day"),
    count: z.number().int().positive(),
    scope: ConstraintScope,
  }),
  z.object({
    type: z.literal("fixture_on_weekday"),
    selector: FixtureSelector,
    weekday: WeekdayCode,
    scope: ConstraintScope,
  }),
  z.object({
    type: z.literal("fixture_on_date"),
    selector: FixtureSelector,
    date: YMD,
    scope: ConstraintScope,
  }),
  z.object({ type: z.literal("not_before"), time: HHMM, scope: ConstraintScope }),
  z.object({ type: z.literal("not_after"), time: HHMM, scope: ConstraintScope }),
]);
export type HardConstraint = z.infer<typeof HardConstraint>;

/** What the compiler produced, minus the assumptions — those join the pack's
 *  existing `assumptions` array (#396/#397) rather than starting a second one. */
export const ParsedConstraints = z.object({
  hard: z.array(HardConstraint).default([]),
  soft: z
    .array(
      z.object({
        note: z.string(),
        weight: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      }),
    )
    .default([]),
  unparsed: z.array(z.string()).default([]),
});
export type ParsedConstraints = z.infer<typeof ParsedConstraints>;

export const SchedulingConstraints = z.object({
  restMin: z.number().int().nonnegative().optional(), // min minutes between an entrant's fixtures
  restByGroup: z.record(z.string(), z.number().int().nonnegative()).optional(), // per pool/division id (20 Oct)
  noBackToBack: z.boolean().default(false), // ≥1 fixture gap (4 Jun)
  startWindows: z.array(StartWindow).default([]),
  fieldFairness: z.enum(["off", "balance", "rotate"]).default("off"), // 14 Apr
  parallelism: z.enum(["block", "mixed"]).default("mixed"), // 29 May
  /** @deprecated Accepted and stored, read by nothing. Jul3/04 §2 made this the
   *  switch for whether a person double-booking blocked; #399 then made the
   *  write gate refuse an INTRODUCED one absolutely (`isBlockingConflict` lists
   *  `person_overlap` unconditionally), and the placer now avoids one for the
   *  same reason — so neither side consults it. Kept so stored settings and the
   *  wire schema keep parsing; the organiser-facing control it backs should be
   *  retired in its own change, with the UI and dictionaries. */
  crossPersonClash: z.enum(["warn", "hard"]).default("warn"),
  /** Durable division rules, in the SAME vocabulary a compiled instruction
   *  produces (#398), so hard rules have exactly one home and the referee reads
   *  one list. Defaults to [] so every pre-W3 persisted
   *  `schedule_settings.constraints` row still parses — no migration.
   *
   *  `.optional()` rather than `.default([])` on purpose: this type is what
   *  `SlotConfig.constraints` is, and dozens of call sites build it as an object
   *  literal. A defaulted field is REQUIRED in the output type, so a default
   *  here would break every one of them for a field they have no opinion
   *  about. Read it as `constraints?.hard ?? []`. */
  hard: z.array(HardConstraint).optional(),
});
export type SchedulingConstraints = z.infer<typeof SchedulingConstraints>;
