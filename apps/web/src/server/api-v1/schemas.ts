// /api/v1 request/response contracts (doc 08 §3–§5). Single source of truth:
// route handlers parse requests with these, and openapi.ts derives the served
// spec from them — code and contract cannot drift.
//
// NOT server-only: pure Zod, shared with the OpenAPI generator script.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export const Uuid = z.uuid();
export const Slug = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and hyphens");

export const Visibility = z.enum(["private", "unlisted", "public"]);
export const CompetitionStatus = z.enum(["draft", "published", "live", "completed", "archived"]);
export const DivisionStatus = z.enum(["setup", "active", "completed"]);
export const StageKind = z.enum(["league", "group", "swiss", "knockout", "double_elim", "stepladder"]);
export const EntrantKind = z.enum(["team", "individual", "pair"]);
export const EntrantStatus = z.enum(["registered", "confirmed", "withdrawn", "disqualified"]);
export const ApiKeyScope = z.enum(["read", "write"]);

// ---------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------

export const CreateCompetition = z.object({
  name: z.string().min(1).max(200),
  slug: Slug.optional(), // derived from name when omitted
  description: z.string().max(5000).nullish(),
  starts_on: z.iso.date().nullish(),
  ends_on: z.iso.date().nullish(),
  visibility: Visibility.default("private"),
  branding: z.record(z.string(), z.unknown()).default({}),
});
export type CreateCompetition = z.infer<typeof CreateCompetition>;

export const PatchCompetition = z
  .object({
    name: z.string().min(1).max(200),
    slug: Slug,
    description: z.string().max(5000).nullable(),
    starts_on: z.iso.date().nullable(),
    ends_on: z.iso.date().nullable(),
    visibility: Visibility,
    branding: z.record(z.string(), z.unknown()),
    status: CompetitionStatus,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchCompetition = z.infer<typeof PatchCompetition>;

export const Competition = z.object({
  id: Uuid,
  org_id: Uuid,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  visibility: Visibility,
  branding: z.record(z.string(), z.unknown()),
  status: CompetitionStatus,
  created_at: z.string(),
  /** doc 10 §2.4 — true when over-quota after a downgrade (read-only). */
  frozen: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Divisions
// ---------------------------------------------------------------------------

export const CreateDivision = z.object({
  name: z.string().min(1).max(200),
  slug: Slug.optional(),
  sport_key: z.string().min(1),
  variant_key: z.string().min(1),
  /** Merged over the variant preset, then validated by the sport module. */
  config: z.record(z.string(), z.unknown()).default({}),
  eligibility: z.array(z.record(z.string(), z.unknown())).default([]),
  tiebreakers: z.array(z.string()).nullish(),
});
export type CreateDivision = z.infer<typeof CreateDivision>;

export const PatchDivision = z
  .object({
    name: z.string().min(1).max(200),
    eligibility: z.array(z.record(z.string(), z.unknown())),
    tiebreakers: z.array(z.string()).nullable(),
    status: DivisionStatus,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchDivision = z.infer<typeof PatchDivision>;

export const Division = z.object({
  id: Uuid,
  competition_id: Uuid,
  name: z.string(),
  slug: z.string(),
  sport_key: z.string(),
  variant_key: z.string(),
  config: z.unknown(),
  module_version: z.string(),
  eligibility: z.array(z.unknown()),
  tiebreakers: z.array(z.string()).nullable(),
  status: DivisionStatus,
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Entrants
// ---------------------------------------------------------------------------

export const EntrantMemberInput = z.object({
  person_id: Uuid,
  squad_number: z.number().int().min(0).nullish(),
  default_position_key: z.string().nullish(),
  is_captain: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
});

export const CreateEntrant = z.object({
  kind: EntrantKind,
  display_name: z.string().min(1).max(200),
  team_id: Uuid.nullish(),
  seed: z.number().int().min(1).nullish(),
  members: z.array(EntrantMemberInput).default([]),
});
export type CreateEntrant = z.infer<typeof CreateEntrant>;

/** POST /divisions/{id}/entrants — one entrant or a bulk array (doc 08 §3). */
export const CreateEntrants = z.union([CreateEntrant, z.array(CreateEntrant).min(1).max(500)]);

export const PatchEntrant = z
  .object({
    display_name: z.string().min(1).max(200),
    seed: z.number().int().min(1).nullable(),
    status: EntrantStatus, // withdraw = status: 'withdrawn'
    members: z.array(EntrantMemberInput), // full replacement
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchEntrant = z.infer<typeof PatchEntrant>;

export const Entrant = z.object({
  id: Uuid,
  division_id: Uuid,
  kind: EntrantKind,
  team_id: Uuid.nullable(),
  display_name: z.string(),
  seed: z.number().int().nullable(),
  status: EntrantStatus,
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Persons & profiles
// ---------------------------------------------------------------------------

export const Consent = z
  .object({
    public_name: z.boolean().optional(),
    public_photo: z.boolean().optional(),
  })
  .default({});

export const CreatePerson = z.object({
  full_name: z.string().min(1).max(200),
  dob: z.iso.date().nullish(), // eligibility only; never exposed publicly
  gender: z.enum(["m", "f", "x"]).nullish(),
  consent: Consent,
  external_ref: z.string().max(200).nullish(),
});
export type CreatePerson = z.infer<typeof CreatePerson>;

export const PatchPerson = z
  .object({
    full_name: z.string().min(1).max(200),
    dob: z.iso.date().nullable(),
    gender: z.enum(["m", "f", "x"]).nullable(),
    consent: z.object({ public_name: z.boolean().optional(), public_photo: z.boolean().optional() }),
    external_ref: z.string().max(200).nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchPerson = z.infer<typeof PatchPerson>;

export const MergePersons = z.object({ duplicate_id: Uuid });
export type MergePersons = z.infer<typeof MergePersons>;

export const PutProfile = z.object({
  attributes: z.record(z.string(), z.unknown()),
});
export type PutProfile = z.infer<typeof PutProfile>;

export const Person = z.object({
  id: Uuid,
  full_name: z.string(),
  dob: z.string().nullable(),
  gender: z.enum(["m", "f", "x"]).nullable(),
  consent: z.record(z.string(), z.unknown()),
  external_ref: z.string().nullable(),
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

export const CreateStage = z.object({
  seq: z.number().int().min(1),
  kind: StageKind,
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  qualification: z.record(z.string(), z.unknown()).nullish(),
});

/** POST /divisions/{id}/stages — the stage graph, one or many (doc 08 §3). */
export const CreateStages = z.union([CreateStage, z.array(CreateStage).min(1).max(20)]);
export type CreateStages = z.infer<typeof CreateStages>;

export const Stage = z.object({
  id: Uuid,
  division_id: Uuid,
  seq: z.number().int(),
  kind: StageKind,
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  qualification: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["pending", "active", "complete"]),
});

// ---------------------------------------------------------------------------
// Fixtures, lineups, scoring
// ---------------------------------------------------------------------------

export const PatchFixture = z
  .object({
    scheduled_at: z.iso.datetime({ offset: true }).nullable(),
    venue: z.string().max(200).nullable(),
    court_label: z.string().max(100).nullable(),
    officials: z.array(z.record(z.string(), z.unknown())),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchFixture = z.infer<typeof PatchFixture>;

export const Fixture = z.object({
  id: Uuid,
  stage_id: Uuid,
  division_id: Uuid,
  pool_id: Uuid.nullable(),
  round_no: z.number().int(),
  seq_in_round: z.number().int(),
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  scheduled_at: z.string().nullable(),
  venue: z.string().nullable(),
  court_label: z.string().nullable(),
  officials: z.array(z.unknown()),
  status: z.enum(["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled"]),
  outcome: z.unknown().nullable(),
  created_at: z.string(),
});

export const LineupSlotInput = z.object({
  person_id: Uuid,
  slot: z.enum(["starting", "bench"]).default("starting"),
  position_key: z.string().nullish(),
  order_no: z.number().int().min(1).nullish(),
  roles: z.array(z.string()).default([]),
});

export const PutLineup = z.object({
  slots: z.array(LineupSlotInput).max(100),
});
export type PutLineup = z.infer<typeof PutLineup>;

/** THE scoring request (doc 08 §4). */
export const AppendEventRequest = z.object({
  expected_seq: z.number().int().min(0),
  type: z.string().min(1).max(100), // 'cricket.ball', 'core.void', …
  payload: z.unknown(),
  idempotency_key: z.string().min(1).max(200).optional(),
});
export type AppendEventRequest = z.infer<typeof AppendEventRequest>;

export const ScoreEvent = z.object({
  id: Uuid,
  seq: z.number().int(),
  type: z.string(),
  payload: z.unknown(),
  recorded_at: z.string(),
  recorded_by: Uuid.nullable(),
  voids_event_id: Uuid.nullable(),
});

export const AppendEventResponse = z.object({
  seq: z.number().int(),
  state_summary: z.unknown(),
  outcome: z.unknown().nullable(),
  status: z.string(),
});

export const FixtureState = z.object({
  fixture_id: Uuid,
  status: z.string(),
  last_seq: z.number().int(),
  summary: z.unknown(),
  state: z.unknown(),
  outcome: z.unknown().nullable(),
});

export const StandingsRowOut = z.object({
  entrantId: z.string(),
  rank: z.number().int(),
  played: z.number().optional(),
  points: z.number().optional(),
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export const CreateApiKey = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(ApiKeyScope).min(1).default(["read"]),
});
export type CreateApiKey = z.infer<typeof CreateApiKey>;

export const ApiKey = z.object({
  id: Uuid,
  name: z.string(),
  scopes: z.array(ApiKeyScope),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

export const CreatedApiKey = ApiKey.extend({
  /** The sk_live_ secret — returned exactly once, at creation. */
  secret: z.string(),
});

// ---------------------------------------------------------------------------
// Generate (fixtures) response
// ---------------------------------------------------------------------------

export const GenerateResult = z.object({
  created: z.number().int(),
  existing: z.number().int(),
  fixtures: z.array(Fixture),
});

export const CompleteResult = z.object({
  completed: z.boolean(),
  events: z.array(z.record(z.string(), z.unknown())),
  /** Set when completion resolved the next stage's qualification spec. */
  qualified: z.object({ stage_id: Uuid, entrants: z.array(Uuid) }).optional(),
});
