// Import domain model (Jul3/01 §3) — types first, Zod schema → inferred type
// (PROMPT-00 §3). The planner is the pure half of the pipeline: the app parses
// the upload into ImportRow[], fetches the ImportSnapshot, and executes the
// resulting ImportPlan; nothing in this package performs I/O.
import { z } from "zod";

// One spreadsheet row, already header-mapped by the app. A row may carry a
// club, a team, a player, or all three — sparse fields are how "clubs + teams
// + players together" works (Jul3/01 §3).
export const ImportRow = z.object({
  rowNo: z.number().int(), // 1-based source line, for issue anchoring
  clubName: z.string().optional(),
  clubShortName: z.string().optional(),
  clubExternalRef: z.string().optional(),
  teamName: z.string().optional(),
  teamShortName: z.string().optional(),
  playerFullName: z.string().optional(),
  dob: z.string().date().optional(),
  gender: z.enum(["m", "f", "x"]).optional(),
  squadNumber: z.number().int().optional(),
  position: z.string().optional(), // validated vs division sport position_catalog
  isCaptain: z.boolean().optional(),
  divisionSlug: z.string().optional(), // where to place the team as an entrant
  entrantDisplayName: z.string().optional(),
});
export type ImportRow = z.infer<typeof ImportRow>;

// Read-only view of current org state the planner matches against (Jul3/01
// §3; the app fetches it, the planner never queries). `memberPersonIds` on
// entrants is required for roster idempotence — re-planning committed rows
// must see existing memberships and emit zero ops (Jul3/01 §4).
export const ImportSnapshot = z.object({
  clubs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      shortName: z.string().nullable(),
      externalRef: z.string().nullable(),
    }),
  ),
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      clubId: z.string().nullable(),
    }),
  ),
  persons: z.array(
    z.object({
      id: z.string(),
      fullName: z.string(),
      dob: z.string().nullable(),
      externalRef: z.string().nullable(),
    }),
  ),
  divisions: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      sportKey: z.string(),
      positionKeys: z.array(z.string()),
    }),
  ),
  entrants: z.array(
    z.object({
      id: z.string(),
      divisionId: z.string(),
      teamId: z.string().nullable(),
      memberPersonIds: z.array(z.string()),
    }),
  ),
});
export type ImportSnapshot = z.infer<typeof ImportSnapshot>;

export const ImportConfig = z.object({
  personMatch: z.enum(["strict", "lenient"]).default("lenient"),
  createDivisions: z.literal(false).default(false), // import never creates divisions (Jul3/01 §4)
  minorConsentDefault: z.boolean().default(false), // doc 06 §4.7
});
export type ImportConfig = z.infer<typeof ImportConfig>;

// A target that may be an existing row (id) or an op created earlier in this
// plan (ref) — the app resolves refs → real uuids as it executes in
// dependency order (Jul3/01 §3).
const Target = z.union([
  z.object({ id: z.string() }),
  z.object({ ref: z.string() }),
]);
export type ImportTarget = z.infer<typeof Target>;

const sourceRows = z.array(z.number().int());

// Jul3/01 §3 op kinds. `roster.add` covers entrant membership (the design's
// roster.add / entrant.member.add pair — one op, target picks new-or-existing
// entrant).
export const ImportOp = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("club.create"),
    ref: z.string(),
    after: z.object({
      name: z.string(),
      shortName: z.string().optional(),
      externalRef: z.string().optional(),
    }),
    sourceRows,
  }),
  z.object({
    kind: z.literal("club.update"),
    ref: z.string(),
    clubId: z.string(),
    before: z.object({ shortName: z.string().nullable() }),
    after: z.object({ shortName: z.string() }),
    sourceRows,
  }),
  z.object({
    kind: z.literal("team.create"),
    ref: z.string(),
    after: z.object({
      name: z.string(),
      shortName: z.string().optional(),
      club: Target.optional(),
    }),
    sourceRows,
  }),
  z.object({
    kind: z.literal("team.link"),
    ref: z.string(),
    teamId: z.string(),
    club: Target,
    sourceRows,
  }),
  z.object({
    kind: z.literal("person.create"),
    ref: z.string(),
    after: z.object({
      fullName: z.string(),
      dob: z.string().optional(),
      gender: z.enum(["m", "f", "x"]).optional(),
      // doc 06 §4.7: consent defaults false unless the organiser attests
      consent: z.object({ public_name: z.boolean(), public_photo: z.boolean() }),
    }),
    sourceRows,
  }),
  z.object({
    kind: z.literal("entrant.create"),
    ref: z.string(),
    divisionId: z.string(),
    after: z.object({
      kind: z.literal("team"),
      team: Target,
      displayName: z.string(),
    }),
    sourceRows,
  }),
  z.object({
    kind: z.literal("roster.add"),
    entrant: Target,
    person: Target,
    after: z.object({
      squadNumber: z.number().int().optional(),
      positionKey: z.string().optional(),
      isCaptain: z.boolean(),
    }),
    sourceRows,
  }),
]);
export type ImportOp = z.infer<typeof ImportOp>;

export const ImportIssue = z.object({
  rowNo: z.number().int(),
  column: z.string().optional(),
  severity: z.enum(["error", "warn"]),
  code: z.string(), // 'DIVISION_NOT_FOUND','AMBIGUOUS_PERSON','BAD_POSITION',…
  message: z.string(),
});
export type ImportIssue = z.infer<typeof ImportIssue>;

export const ImportPlan = z.object({
  ops: z.array(ImportOp),
  stats: z.object({
    clubs: z.number().int(),
    teams: z.number().int(),
    persons: z.number().int(),
    entrants: z.number().int(),
    rosters: z.number().int(),
  }),
  issues: z.array(ImportIssue),
});
export type ImportPlan = z.infer<typeof ImportPlan>;
