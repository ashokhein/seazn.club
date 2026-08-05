// /api/v1 request/response contracts (doc 08 §3–§5). Single source of truth:
// route handlers parse requests with these, and openapi.ts derives the served
// spec from them — code and contract cannot drift.
//
// NOT server-only: pure Zod, shared with the OpenAPI generator script.
import { z } from "zod";
// #398: durable division rules speak the SAME vocabulary a compiled instruction
// does, so the wire schema reuses the engine's zod rather than restating it —
// a second declaration is a second thing to drift.
import { HardConstraint } from "@seazn/engine/scheduling";

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
// Doc 12 §1: 'scheduled' = timetable published, scoring not yet open.
export const DivisionStatus = z.enum(["setup", "scheduled", "active", "completed"]);
export const StageKind = z.enum(["league", "group", "swiss", "knockout", "double_elim", "stepladder", "page_playoff", "americano", "ladder"]);
export const EntrantKind = z.enum(["team", "individual", "pair"]);
export const EntrantStatus = z.enum(["registered", "confirmed", "withdrawn", "disqualified"]);
// v3/08 §2: ranked scopes — read < score < manage. "write" is the legacy
// name for manage; still accepted on input, stored as manage.
export const ApiKeyScope = z.enum(["read", "score", "manage", "write"]);

// ---------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------

export const CreateCompetition = z.object({
  name: z.string().min(1).max(200),
  slug: Slug.optional(), // derived from name when omitted
  /** Markdown (v3/06 §2) — rendered through lib/prose on every surface. */
  description: z.string().max(20_000).nullish(),
  starts_on: z.iso.date().nullish(),
  ends_on: z.iso.date().nullish(),
  visibility: Visibility.default("private"),
  branding: z.record(z.string(), z.unknown()).default({}),
  /** Doc 15 §1 "Showcase on seazn.club" — opt-in at create time; requires
   *  public visibility, same rule as PATCH. Omitted = false. */
  discoverable: z.boolean().optional(),
});
export type CreateCompetition = z.infer<typeof CreateCompetition>;

/** Organiser-entered discovery presentation (doc 15 §1). tagline/hero are
 *  `discovery.branding`-gated at the write (use-case), not here. */
export const DiscoveryInfo = z
  .object({
    city: z.string().max(100).nullish(),
    country: z.string().max(100).nullish(),
    tagline: z.string().max(200).nullish(),
    hero_image_path: z.string().max(500).nullish(),
  })
  .strict();
export type DiscoveryInfo = z.infer<typeof DiscoveryInfo>;

export const PatchCompetition = z
  .object({
    name: z.string().min(1).max(200),
    slug: Slug,
    description: z.string().max(20_000).nullable(),
    starts_on: z.iso.date().nullable(),
    ends_on: z.iso.date().nullable(),
    visibility: Visibility,
    branding: z.record(z.string(), z.unknown()),
    status: CompetitionStatus,
    /** Doc 15 §1 "Showcase on seazn.club" — explicit opt-in, public only. */
    discoverable: z.boolean(),
    discovery: DiscoveryInfo,
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
  discoverable: z.boolean(),
  discovery: DiscoveryInfo,
  /** doc 10 §2.4 — true when over-quota after a downgrade (read-only). */
  frozen: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Divisions
// ---------------------------------------------------------------------------

/** F5: the engine's TiebreakerKey union, enforced at the edge — an unknown
 *  key (e.g. the preset NAME "fifa2026") silently no-ops every comparison and
 *  standings degrade to the deterministic seed-order fallback. 400 instead. */
export const TiebreakerKeyS = z.enum([
  "points", "wins", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "nrr",
  "set_ratio", "game_ratio", "board_ratio", "point_ratio", "buchholz",
  "buchholz_cut1", "sberger", "direct", "fair_play", "seed", "lots",
]);

export const CreateDivision = z.object({
  name: z.string().min(1).max(200),
  slug: Slug.optional(),
  sport_key: z.string().min(1),
  variant_key: z.string().min(1),
  /** Merged over the variant preset, then validated by the sport module. */
  config: z.record(z.string(), z.unknown()).default({}),
  eligibility: z.array(z.record(z.string(), z.unknown())).default([]),
  tiebreakers: z.array(TiebreakerKeyS).nullish(),
});
export type CreateDivision = z.infer<typeof CreateDivision>;

export const PatchDivision = z
  .object({
    name: z.string().min(1).max(200),
    /** Markdown (v3/06 §2), shown on the public division page. */
    description: z.string().max(20_000).nullable(),
    eligibility: z.array(z.record(z.string(), z.unknown())),
    tiebreakers: z.array(TiebreakerKeyS).nullable(),
    status: DivisionStatus,
    /** Hide official names on all public reads (Jul3/02, 25 Jun). */
    officials_hide_names: z.boolean(),
    /** Jul3/08 §5: progression fires without a button (Pro formats.advanced). */
    auto_progress: z.boolean(),
    /** SPEC-2: draft a news post when results land (Pro `news.auto` on write). */
    auto_posts: z.boolean(),
    /** Youth flag (v3/11 gap 8): auto-set from U-age eligibility, this is
     *  the organiser override. */
    youth: z.boolean(),
    /** Public name rendering; null resolves youth → first_initial. */
    player_name_display: z.enum(["full", "first_initial"]).nullable(),
    /** Card logo (V274, v8); null reverts the tile to the monogram. */
    logo_storage_path: z.string().max(500).nullable(),
    /** Format edit (v8) — allowed only pre-fixtures; usecase enforces
     *  FORMAT_LOCKED and re-validates via the pinned module schema. */
    variant_key: z.string().min(1).max(100),
    config: z.record(z.string(), z.unknown()),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchDivision = z.infer<typeof PatchDivision>;

export const Division = z.object({
  id: Uuid,
  competition_id: Uuid,
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  sport_key: z.string(),
  variant_key: z.string(),
  config: z.unknown(),
  module_version: z.string(),
  eligibility: z.array(z.unknown()),
  tiebreakers: z.array(TiebreakerKeyS).nullable(),
  status: DivisionStatus,
  officials_hide_names: z.boolean(),
  scheduling_mode: z.enum(["timed", "flexible"]),
  auto_progress: z.boolean(),
  auto_posts: z.boolean(),
  archived_at: z.string().nullable(), // v3/09 §4 — set = archived (hidden, restorable)
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

/** PROMPT-60 §2 — a member created inline with the entrant (same transaction),
 *  so a whole team + roster is one request. Explicit person_id remains the way
 *  to reuse an existing person; inline members are never merged/deduped
 *  against existing org persons. Create-time only. */
export const NewPersonMemberInput = z.object({
  new_person: z.object({ full_name: z.string().min(1).max(200) }),
  squad_number: z.number().int().min(0).nullish(),
  default_position_key: z.string().nullish(),
  is_captain: z.boolean().default(false),
  roles: z.array(z.string()).default([]),
});
export const CreateEntrantMemberInput = z.union([EntrantMemberInput, NewPersonMemberInput]);
export type CreateEntrantMemberInput = z.infer<typeof CreateEntrantMemberInput>;

export const CreateEntrant = z
  .object({
    kind: EntrantKind,
    // Optional when enrolling an existing team: the server snapshots the name
    // from teams.name at creation so a later rename never rewrites history.
    display_name: z.string().min(1).max(200).optional(),
    team_id: Uuid.nullish(),
    seed: z.number().int().min(1).nullish(),
    // National-squad sizes (~26) must pass; 40 caps abuse (PROMPT-60 §2).
    members: z.array(CreateEntrantMemberInput).max(40).default([]),
    // Copy the roster from an earlier entrant of the SAME team (season rollover,
    // league + cup). Resolved server-side in the creation transaction.
    copy_roster_from_entrant_id: Uuid.nullish(),
    // PROMPT-60: lightweight crest/badge/flag — an external URL or an
    // assets-bucket storage path. Club-independent, so free orgs get it.
    badge_url: z.string().min(1).max(1000).nullish(),
  })
  .refine((e) => e.display_name != null || e.team_id != null, {
    message: "display_name is required unless team_id is provided",
    path: ["display_name"],
  });
export type CreateEntrant = z.infer<typeof CreateEntrant>;

/** POST /divisions/{id}/entrants — one entrant or a bulk array (doc 08 §3). */
export const CreateEntrants = z.union([CreateEntrant, z.array(CreateEntrant).min(1).max(500)]);

/** POST /clubs/{id}/teams — create a team under a club. */
export const CreateTeam = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().max(60).nullish(),
});
export type CreateTeam = z.infer<typeof CreateTeam>;

/** PUT /teams/{id}/squad — full-replace the team's persistent squad. */
export const SetTeamSquad = z.object({
  members: z.array(EntrantMemberInput).default([]),
});
export type SetTeamSquad = z.infer<typeof SetTeamSquad>;

export const PatchEntrant = z
  .object({
    display_name: z.string().min(1).max(200),
    seed: z.number().int().min(1).nullable(),
    status: EntrantStatus, // withdraw = status: 'withdrawn'
    members: z.array(EntrantMemberInput), // full replacement
    badge_url: z.string().min(1).max(1000).nullable(), // PROMPT-60
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
  /** Set once a player has claimed this row (PROMPT-53). */
  user_id: Uuid.nullable(),
  created_at: z.string(),
  /** List read only: an open, unexpired claim invite exists. */
  claim_pending: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Player accounts (PROMPT-53) — claims, availability, the /me surface
// ---------------------------------------------------------------------------

export const CreateClaimInvite = z.object({ email: z.email().max(200) });
export type CreateClaimInvite = z.infer<typeof CreateClaimInvite>;

export const PersonClaim = z.object({
  id: Uuid,
  person_id: Uuid,
  email: z.string(),
  invited_by: Uuid.nullable(),
  expires_at: z.string(),
  claimed_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

/** POST response only — claim_url embeds the secret, shown exactly once. */
export const CreatedPersonClaim = PersonClaim.extend({
  claim_url: z.string(),
  /** Whether the invite email was accepted by the provider. */
  email_sent: z.boolean(),
});

export const PutAvailability = z.object({
  status: z.enum(["in", "out", "maybe"]),
  note: z.string().max(280).nullish(),
});
export type PutAvailability = z.infer<typeof PutAvailability>;

export const Availability = z.object({
  fixture_id: Uuid,
  person_id: Uuid,
  status: z.enum(["in", "out", "maybe"]),
  note: z.string().nullable(),
  checked_in_at: z.string().nullable(),
  updated_at: z.string(),
});

export const PatchMyConsent = z
  .object({ public_name: z.boolean(), public_photo: z.boolean() })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchMyConsent = z.infer<typeof PatchMyConsent>;

/** dob never rides out — only the derived guardian lock does. */
export const MyPerson = z.object({
  id: Uuid,
  full_name: z.string(),
  org_name: z.string(),
  consent: z.object({ public_name: z.boolean().optional(), public_photo: z.boolean().optional() }),
  consent_locked: z.boolean(),
});

export const MyFixture = z.object({
  id: Uuid,
  fixture_no: z.number().int(),
  person_id: Uuid,
  person_name: z.string(),
  org_name: z.string(),
  org_slug: z.string(),
  competition_name: z.string(),
  competition_slug: z.string(),
  competition_visibility: z.string(),
  division_name: z.string(),
  division_slug: z.string(),
  sport_key: z.string(),
  round_no: z.number().int(),
  entrant_name: z.string().nullable(),
  opponent_name: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  venue: z.string().nullable(),
  court_label: z.string().nullable(),
  status: z.string(),
  availability: z
    .object({ status: z.enum(["in", "out", "maybe"]), note: z.string().nullable() })
    .nullable(),
  checked_in_at: z.string().nullable(),
});

export const MyResult = z.object({
  id: Uuid,
  fixture_no: z.number().int(),
  competition_name: z.string(),
  competition_slug: z.string(),
  competition_visibility: z.string(),
  division_name: z.string(),
  division_slug: z.string(),
  org_name: z.string(),
  org_slug: z.string(),
  entrant_name: z.string().nullable(),
  opponent_name: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  summary: z.unknown().nullable(),
  outcome: z.unknown().nullable(),
});

export const MyTeam = z.object({
  entrant_id: Uuid,
  entrant_name: z.string(),
  division_name: z.string(),
  competition_name: z.string(),
  org_name: z.string(),
  sport_key: z.string(),
});

export const MyFixtures = z.object({
  upcoming: z.array(MyFixture),
  results: z.array(MyResult),
  teams: z.array(MyTeam),
});

export const CheckinLink = z.object({ url: z.string(), expires_at: z.string() });

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

// PROMPT-59 §4 — typed qualification spec, so a bad shape 400s at the edge
// instead of throwing deep inside the engine. Mirrors engine
// `QualificationSpec` (TakePicks | TopN | BestOfRank | CombinedQualification).
// `take[].pool` matches the pool KEY ("A"); the display name ("Pool A") is
// also accepted — the engine normalises.
const PoolRankPickS = z.object({ pool: z.string().min(1), rank: z.number().int().min(1) });
const TakePicksS = z
  .object({ from: z.string().optional(), take: z.array(PoolRankPickS).min(1) })
  .strict();
const TopNS = z.object({ from: z.string().optional(), topN: z.number().int().min(1) }).strict();
const BestOfRankS = z
  .object({
    from: z.string().optional(),
    bestOfRank: z.object({
      rank: z.number().int().min(1),
      count: z.number().int().min(1),
      normaliseUnequalPools: z.boolean().optional(),
    }),
  })
  .strict();
export type QualificationSpecInput =
  | z.infer<typeof TakePicksS>
  | z.infer<typeof TopNS>
  | z.infer<typeof BestOfRankS>
  | { from?: string; combine: QualificationSpecInput[] };
export const QualificationSpecSchema: z.ZodType<QualificationSpecInput> = z.lazy(() =>
  z.union([
    TakePicksS,
    TopNS,
    BestOfRankS,
    z
      .object({ from: z.string().optional(), combine: z.array(QualificationSpecSchema).min(2).max(8) })
      .strict(),
  ]),
);

export const CreateStage = z.object({
  seq: z.number().int().min(1),
  kind: StageKind,
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()).default({}),
  qualification: QualificationSpecSchema.nullish(),
});

/** POST /divisions/{id}/stages — the stage graph, one or many (doc 08 §3). */
export const CreateStages = z.union([CreateStage, z.array(CreateStage).min(1).max(20)]);

/** POST /stages/{id}/fixtures — ad-hoc single fixture (PROMPT-66). */
export const AddFixture = z.object({
  home_entrant_id: Uuid,
  away_entrant_id: Uuid,
  round_no: z.number().int().min(1).optional(),
  scheduled_at: z.string().datetime({ offset: true }).nullish(),
  venue: z.string().max(200).nullish(),
});
export type AddFixture = z.infer<typeof AddFixture>;
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
    /** Pin/lock (doc 12 §2): locked assignments survive re-running auto. */
    schedule_locked: z.boolean(),
    /** Optimistic token (v3/11 gap 10): the division seq the client loaded.
     *  Stale → 409 SEQ_CONFLICT, the board refetches and toasts. */
    expected_seq: z.number().int().nonnegative(),
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
  /** Per-division ordinal (PROMPT-30) — the `/f/{no}` public URL segment.
   *  Declared here because it is already SERVED: `FIXTURE_COLS` selects it and
   *  every fixture route returns its row unmapped. Nothing applies a response
   *  schema at runtime, so its absence was a silent gap between the published
   *  spec and the real payload rather than a missing field. */
  fixture_no: z.number().int(),
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  scheduled_at: z.string().nullable(),
  venue: z.string().nullable(),
  court_label: z.string().nullable(),
  officials: z.array(z.unknown()),
  status: z.enum(["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled"]),
  outcome: z.unknown().nullable(),
  schedule_source: z.enum(["none", "auto", "manual", "ai"]),
  schedule_locked: z.boolean(),
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
  /** Doc 13 §7: set when the event arrived via a day-of device link. */
  device_link_id: Uuid.nullable(),
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
  /** Optional pin: the key only works inside this competition (v3/08 §2). */
  competition_id: Uuid.nullish(),
});
export type CreateApiKey = z.infer<typeof CreateApiKey>;

export const ApiKey = z.object({
  id: Uuid,
  name: z.string(),
  scopes: z.array(ApiKeyScope),
  competition_id: Uuid.nullable(),
  last_used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

export const CreatedApiKey = ApiKey.extend({
  /** The sc_ secret — returned exactly once, at creation. */
  secret: z.string(),
});

// ---------------------------------------------------------------------------
// Device links (doc 13 §7, PROMPT-21)
// ---------------------------------------------------------------------------

export const CreateDeviceLink = z.object({
  /** 'Court 3 phone' — organiser-facing label, optional. */
  label: z.string().min(1).max(100).nullish(),
});
export type CreateDeviceLink = z.infer<typeof CreateDeviceLink>;

export const DeviceLink = z.object({
  id: Uuid,
  fixture_id: Uuid,
  label: z.string().nullable(),
  issued_by: Uuid,
  expires_at: z.string(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});

export const CreatedDeviceLink = DeviceLink.extend({
  /** The dl_ secret — returned exactly once, at mint. QR payload = /score/{secret}. */
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

// ---------------------------------------------------------------------------
// Scheduling console (doc 12, PROMPT-17)
// ---------------------------------------------------------------------------

const IsoDateTime = z.iso.datetime({ offset: true });

/** Doc 12 §3 schedule_settings.config — the calendar pass inputs (05 §2.6). */
export const ScheduleConfig = z.object({
  startAt: IsoDateTime.nullish(),
  /** Last day the timetable runs — drives the week view's day span. */
  endAt: IsoDateTime.nullish(),
  matchMinutes: z.number().int().min(1).max(24 * 60).default(30),
  gapMinutes: z.number().int().min(0).max(24 * 60).default(0),
  courts: z.array(z.string().min(1).max(100)).min(1).max(50).default(["Court 1"]),
  perEntrantMinRest: z.number().int().min(0).max(24 * 60).default(0),
  blackouts: z
    .array(z.object({ court: z.string().max(100).optional(), from: IsoDateTime, to: IsoDateTime }))
    .max(200)
    .default([]),
  sessionWindows: z
    .array(z.object({ from: IsoDateTime, to: IsoDateTime }))
    .max(200)
    .default([]),
  /** Quick-start rolling times (doc 12 §1.A): round r starts at startAt + (r−1)·roundMinutes. */
  roundMinutes: z.number().int().min(1).max(24 * 60).nullish(),
  /** Constraints v2 (Jul3/04 §3; Pro `scheduling.constraints`). API times are
   *  ISO; the engine consumes epoch ms. */
  constraints: z
    .object({
      restMin: z.number().int().min(0).max(24 * 60).optional(),
      restByGroup: z.record(z.string(), z.number().int().min(0).max(24 * 60)).optional(),
      noBackToBack: z.boolean().default(false),
      startWindows: z
        .array(
          z.object({
            target: z.object({ kind: z.enum(["entrant", "pool", "division"]), id: z.string() }),
            notBefore: IsoDateTime.optional(),
            notAfter: IsoDateTime.optional(),
          }),
        )
        .max(200)
        .default([]),
      fieldFairness: z.enum(["off", "balance", "rotate"]).default("off"),
      parallelism: z.enum(["block", "mixed"]).default("mixed"),
      crossPersonClash: z.enum(["warn", "hard"]).default("warn"),
      /** Durable division rules (#398) in the SAME vocabulary a compiled
       *  instruction produces — per-day caps, weekday and date targets,
       *  earliest/latest starts, minimum rest. They merge with the compiled
       *  instruction into one stream at `verifyConfig`, so a hard rule has
       *  exactly one home and one enforcement.
       *
       *  Optional, never defaulted: this type is built as an object literal at
       *  dozens of call sites, and a defaulted field is required in the zod
       *  OUTPUT type. Read it as `constraints?.hard ?? []`. */
      hard: z.array(HardConstraint).max(200).optional(),
    })
    .optional(),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfig>;

export const PutScheduleSettings = z.object({
  config: ScheduleConfig,
  /**
   * Venue-local timezone (doc 12 §6 — DST boundaries in sessionWindows).
   *
   * Since V305 the venue zone is set on the ORGANISATION and inherited; there
   * is no division-level timezone control in the console any more. The column
   * and this field survive for the divisions that already hold a value (and
   * for platform-API clients), so this is tri-state:
   *   omitted  → leave the division's stored value untouched (what the
   *              console now always does — a save must never move a
   *              division's venue zone)
   *   null     → clear it, inherit from the org
   *   string   → pin this division to an explicit zone
   */
  tz: z.string().min(1).max(64).nullish(),
});
export type PutScheduleSettings = z.infer<typeof PutScheduleSettings>;

export const ScheduleSettings = z.object({
  division_id: Uuid,
  config: ScheduleConfig,
  /** RESOLVED venue zone (V305): stored division tz → org timezone → 'UTC'. */
  tz: z.string(),
  updated_at: z.string(),
});

/** The rule vocabulary the scheduling prompts teach (#399). `CAP` is the
 *  capacity case: demand exceeded capacity and no single rule was broken. */
export const RuleCode = z.enum(["H2", "H3", "H4", "H5", "H6", "H8", "CAP"]);
export type RuleCode = z.infer<typeof RuleCode>;

/** Doc 12 §2 conflict taxonomy. Since #399 `blocking` is DELTA-based: a court
 *  clash, a person double-booking, an out-of-window slot or a direct feed
 *  ordering breach blocks when THIS change introduced or worsened it. The same
 *  conflict already on the board comes back as a badge, so a dirty board stays
 *  editable. Blocked writes are rejected; warnings persist as badges. */
export const ScheduleConflict = z.object({
  fixture_id: Uuid,
  code: z.enum([
    "conflict.court",
    "conflict.start_window",
    "warn.rest",
    "warn.person_overlap",
    "warn.order",
    "warn.blackout",
    // #397: outside the competition's resolved calendar window. A warning this
    // wave — W4 (#399) makes it blocking, and delta-based so a board that was
    // already outside its window stays editable.
    "warn.window",
    // #398: breaks a rule compiled from the organiser's own instruction ("two
    // matches per day", "final on Friday"), or a durable division rule in the
    // same vocabulary. A warning this wave — W4 (#399) gives it rule code H8
    // and decides what blocks.
    "warn.instruction",
    "warn.no_slot",
    "warn.official_declined",
    "warn.official_unavailable",
  ]),
  blocking: z.boolean(),
  detail: z.string().optional(),
  /** The rule this conflict breaks, in the vocabulary the AI prompts teach
   *  (#399) — so a refusal, a badge and a repair round all cite one token. */
  rule: RuleCode.optional(),
  /** How far a MEASURED breach falls short, in minutes (#399). Carried beside
   *  the conflict rather than inside `detail`, because `detail` is part of the
   *  conflict's identity and a number in there would move that identity every
   *  time the card moved. */
  shortfall_minutes: z.number().int().optional(),
});
export type ScheduleConflict = z.infer<typeof ScheduleConflict>;

/** The PATCH /fixtures/{id} response (#461).
 *
 *  The fixture as `Fixture` describes it, PLUS the conflicts the move was judged
 *  against. `moveFixture` has always computed a full report for the destination
 *  slot; it used it for the blocking gate and then discarded it, because the
 *  function returned `void`. Blocking conflicts 409 and are visible that way, so
 *  the ones this field exists for are the WARN-level ones — a rest shortfall, a
 *  stored typed rule, a slot outside the competition's days — which an API
 *  client dragging a card previously heard nothing about.
 *
 *  Always present, `[]` when the patch touched no timetable field, so a client
 *  need not distinguish "no conflicts" from "not evaluated" by key absence.
 *  Additive: no existing consumer of this endpoint reads it. */
export const PatchedFixture = Fixture.extend({
  conflicts: z.array(ScheduleConflict),
});
export type PatchedFixture = z.infer<typeof PatchedFixture>;

export const ScheduleAssignment = z.object({
  fixture_id: Uuid,
  scheduled_at: z.string(),
  ends_at: z.string(),
  court_label: z.string(),
});
export type ScheduleAssignment = z.infer<typeof ScheduleAssignment>;

/** POST /stages/{id}/schedule/auto — propose only, nothing persisted (doc 12 §4). */
export const AutoScheduleRequest = z.object({
  /** true (default) = re-flow unlocked fixtures only, locked ones are fixed
   *  obstacles ("re-flow remaining", doc 12 §2); false = fresh full pass. */
  only_unlocked: z.boolean().default(true),
});
export type AutoScheduleRequest = z.infer<typeof AutoScheduleRequest>;

export const AutoScheduleResult = z.object({
  assignments: z.array(ScheduleAssignment),
  conflicts: z.array(ScheduleConflict),
});

/** POST /stages/{id}/schedule/apply — persist an assignment set. */
/** Optional AI provenance stamped into the apply/assign ledger events (v4/03 §10).
 *  Present only when the apply originated from the AI Schedule/Officials Architect;
 *  the instruction is trimmed server-side and recalled by
 *  GET /divisions/{id}/schedule/ai-last. Shared by ApplyScheduleRequest and the
 *  officials ApplyAssignmentsInput. */
export const AiApplyMeta = z.object({
  /** Trimmed server-side at the apply seam (schedule.ts / officials.ts), so it
   *  stays a plain string here — a zod transform would break openapi:gen. */
  instruction: z.string().max(500),
  summary: z.string().max(600),
  model: z.string(),
  repair_rounds: z.number().int().nonnegative(),
});
export type AiApplyMeta = z.infer<typeof AiApplyMeta>;

export const ApplyScheduleRequest = z.object({
  assignments: z
    .array(
      z.object({
        fixture_id: Uuid,
        scheduled_at: IsoDateTime,
        court_label: z.string().min(1).max(100),
        venue: z.string().max(200).nullish(),
        schedule_locked: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(500),
  source: z.enum(["auto", "manual", "ai"]).default("auto"),
  /** Optimistic token (v3/11 gap 10) — see PatchFixture.expected_seq. */
  expected_seq: z.number().int().nonnegative().optional(),
  /** Audit provenance when source === "ai" (v4/03 §10). */
  ai: AiApplyMeta.optional(),
});
export type ApplyScheduleRequest = z.infer<typeof ApplyScheduleRequest>;

/** GET /divisions/{id}/schedule/ai-last — the most recent AI-sourced apply
 *  (null when the division has never been AI-scheduled) plus the division's
 *  generation budget: `used` counts successful schedule generations from the
 *  run ledger, `max` is the plan's per-division cap (null = unlimited). */
export const AiLastResult = z.object({
  last: z.object({ at: z.string(), instruction: z.string(), summary: z.string() }).nullable(),
  runs: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
});
export type AiLastResult = z.infer<typeof AiLastResult>;

export const ApplyScheduleResult = z.object({
  applied: z.number().int(),
  conflicts: z.array(ScheduleConflict),
});

export const ValidateScheduleResult = z.object({
  conflicts: z.array(ScheduleConflict),
});

export const PublishScheduleResult = z.object({
  division_id: Uuid,
  status: DivisionStatus,
  published: z.boolean(),
});

// ---------------------------------------------------------------------------
// Scorer console (doc 13, PROMPT-18)
// ---------------------------------------------------------------------------

/** GET /me/assigned-fixtures — the "My matches" read (doc 13 §3/§6). */
export const AssignedFixture = z.object({
  id: Uuid,
  org_id: Uuid,
  org_name: z.string(),
  competition_id: Uuid,
  competition_name: z.string(),
  division_id: Uuid,
  division_name: z.string(),
  division_status: z.string(),
  sport_key: z.string(),
  module_version: z.string(),
  round_no: z.number().int(),
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  home_name: z.string().nullable(),
  away_name: z.string().nullable(),
  scheduled_at: z.string().nullable(),
  venue: z.string().nullable(),
  court_label: z.string().nullable(),
  status: z.string(),
});

export const StartDivisionResult = z.object({
  division_id: Uuid,
  status: DivisionStatus,
  started: z.boolean(),
  /** Fixtures generated by quick-start (0 when they already existed). */
  generated: z.number().int(),
});

// ---------------------------------------------------------------------------
// Registration & entry fees (doc 16 §1.1, PROMPT-20a)
// ---------------------------------------------------------------------------

export const RegistrationStatus = z.enum([
  "pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired",
]);

/** How a division collects its entry fee (spec 2026-07-12 §3). */
export const RegistrationPaymentMethod = z.enum(["offline", "stripe"]);

/** Bounded form-field builder (doc 16 §1.1): text/select/checkbox only. */
export const RegistrationFormField = z
  .object({
    key: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/, "lowercase snake_case"),
    label: z.string().min(1).max(120),
    kind: z.enum(["text", "select", "checkbox"]),
    options: z.array(z.string().min(1).max(80)).min(1).max(20).optional(),
    required: z.boolean().default(false),
  })
  .strict()
  .refine((f) => f.kind !== "select" || (f.options?.length ?? 0) > 0, {
    message: "select fields need options",
  });
export type RegistrationFormField = z.infer<typeof RegistrationFormField>;

export const PutRegistrationSettings = z
  .object({
    enabled: z.boolean(),
    entrant_kind: EntrantKind.default("individual"),
    opens_at: z.iso.datetime({ offset: true }).nullish(),
    closes_at: z.iso.datetime({ offset: true }).nullish(),
    capacity: z.number().int().min(1).max(10000).nullish(),
    fee_cents: z.number().int().min(0).max(100_000_00).default(0),
    currency: z.string().length(3).toLowerCase().default("gbp"),
    refund_lock_at: z.iso.datetime({ offset: true }).nullish(),
    form_fields: z.array(RegistrationFormField).max(12).default([]),
    payment_method: RegistrationPaymentMethod.default("offline"),
    /** Per-division override of the org's offline payment instructions. */
    payment_instructions: z.string().max(5000).nullish(),
  })
  .superRefine((s, ctx) => {
    const keys = s.form_fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "duplicate form field keys" });
    }
  });
/** Input shape (pre-parse): defaulted fields stay optional so direct callers
 *  (tests, scripts) can omit them; the usecase normalises like the route. */
export type PutRegistrationSettings = z.input<typeof PutRegistrationSettings>;

export const RegistrationSettings = z.object({
  division_id: Uuid,
  enabled: z.boolean(),
  entrant_kind: EntrantKind,
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  capacity: z.number().int().nullable(),
  fee_cents: z.number().int(),
  currency: z.string(),
  refund_lock_at: z.string().nullable(),
  form_fields: z.array(RegistrationFormField),
  payment_method: RegistrationPaymentMethod,
  payment_instructions: z.string().nullable(),
  /** Org fallbacks for the settings UI (spec §3). */
  org_payment_instructions: z.string().nullable(),
  org_default_payment_method: z.string(),
  /** Paid registration readiness (org-level): Stripe Connect charges enabled. */
  charges_enabled: z.boolean(),
  updated_at: z.string().nullable(),
});

/** Organiser view of one registration. dob/contact stay org-side only. */
export const Registration = z.object({
  id: Uuid,
  division_id: Uuid,
  status: RegistrationStatus,
  ref_code: z.string().nullable(),
  display_name: z.string(),
  contact_email: z.string(),
  dob: z.string().nullable(),
  gender: z.string().nullable(),
  guardian_name: z.string().nullable(),
  guardian_consent: z.boolean(),
  answers: z.record(z.string(), z.unknown()),
  amount_cents: z.number().int(),
  currency: z.string().nullable(),
  payment_method: z.string().nullable(),
  payment_intent_id: z.string().nullable(),
  refunded_cents: z.number().int(),
  refunded_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  offline_marked_paid_at: z.string().nullable(),
  disputed_at: z.string().nullable(),
  entrant_id: Uuid.nullable(),
  promoted_at: z.string().nullable(),
  withdrawn_at: z.string().nullable(),
  created_at: z.string(),
});

export const RefundRegistration = z.object({
  /** Omitted = refund the full remaining amount. */
  amount_cents: z.number().int().min(1).optional(),
});
export type RefundRegistration = z.infer<typeof RefundRegistration>;

// Public register flow -------------------------------------------------------

/** One division on the public register panel. */
export const PublicRegistrationDivision = z.object({
  division_id: Uuid,
  name: z.string(),
  slug: z.string(),
  sport_key: z.string(),
  entrant_kind: EntrantKind,
  fee_cents: z.number().int(),
  currency: z.string(),
  payment_method: RegistrationPaymentMethod,
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  capacity: z.number().int().nullable(),
  /** Spots left before new submissions waitlist; null = uncapped. */
  remaining: z.number().int().nullable(),
  /** Spots taken — the masthead capacity meter (v3/05 §2). */
  taken: z.number().int(),
  open: z.boolean(),
  /** 'window' | 'full' (waitlist only) | 'payments_unavailable' | null */
  closed_reason: z.string().nullable(),
  requires_dob: z.boolean(),
  /** Youth division (v3/11 gap 8): the form always adds guardian consent. */
  youth: z.boolean(),
  form_fields: z.array(RegistrationFormField),
});

export const PublicRegistrationInfo = z.object({
  competition: z.object({
    id: Uuid,
    name: z.string(),
    slug: z.string(),
    starts_on: z.string().nullable(),
    ends_on: z.string().nullable(),
  }),
  org: z.object({ name: z.string(), slug: z.string(), logo_url: z.string().nullable() }),
  divisions: z.array(PublicRegistrationDivision),
});

export const PublicRegisterRequest = z.object({
  division_id: Uuid,
  display_name: z.string().min(1).max(120),
  contact_email: z.email(),
  dob: z.iso.date().nullish(),
  gender: z.enum(["m", "f", "x"]).nullish(),
  guardian_name: z.string().max(120).nullish(),
  guardian_consent: z.boolean().default(false),
  /** GDPR (spec 2026-07-14): explicit agreement to store/process the form's PII. */
  privacy_consent: z.boolean().default(false),
  /** #402 — the registrant affirms this entry is for THEMSELVES. Only then may
   *  the session be captured. Never inferred from being signed in: a guardian,
   *  spouse or team captain is signed in too. Optional, not defaulted: absent
   *  and false mean the same safe thing (no link), and every existing caller
   *  keeps compiling. */
  registering_self: z.boolean().optional(),
  answers: z.record(z.string(), z.unknown()).default({}),
  // Team registrations may include a squad roster (typed or imported). Ignored
  // for individual/pair entrants.
  players: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        dob: z.iso.date().nullish(),
        squad_number: z.number().int().min(0).max(999).nullish(),
        /** #402 — the submitter declaring which roster row is them. At most one. */
        self: z.boolean().optional(),
      }),
    )
    .max(50)
    .default([]),
  /** Honeypot (v3/05 §4): hidden on the real form; bots that fill it get a
   *  generic rejection in the route before any work happens. */
  website: z.string().max(200).optional(),
}).superRefine((v, ctx) => {
  // #402 — the self-declaration must be coherent before it reaches the person
  // resolver: one roster row at most, and never without the affirmation that
  // authorises capturing the session at all.
  const selves = v.players.filter((p) => p.self).length;
  if (selves > 1) {
    ctx.addIssue({
      code: "custom",
      path: ["players"],
      message: "Only one roster entry may be marked as yourself",
    });
  }
  if (selves > 0 && !v.registering_self) {
    ctx.addIssue({
      code: "custom",
      path: ["players"],
      message: "Marking a roster entry as yourself requires registering_self",
    });
  }
  // #402 — the affirmation needs a date of birth. `dob` is nullish, so without
  // this a parent could affirm "registering myself" for two children who supply
  // no dob, trigger no guardian requirement, and link both to their own account
  // — one persons row for two siblings. The server refuses to link an undated
  // or under-18 registrant regardless; this is the message that says why.
  if (v.registering_self && !v.dob) {
    ctx.addIssue({
      code: "custom",
      path: ["dob"],
      message: "A date of birth is required when you're registering yourself",
    });
  }
});
export type PublicRegisterRequest = z.infer<typeof PublicRegisterRequest>;

export const PublicRegisterResponse = z.object({
  registration_id: Uuid,
  status: RegistrationStatus,
  /** Quotable reference (v3/05 §3) — also on the ticket and in the email. */
  ref_code: z.string().nullable(),
  /** Self-service secret, shown exactly once (status page / withdraw / pay). */
  access_token: z.string(),
  /** Stripe Checkout URL when an entry fee is due now. */
  checkout_url: z.string().nullable(),
});

/** Registrant-facing status view (token-gated; no dob, no payment ids). */
export const PublicRegistrationStatus = z.object({
  id: Uuid,
  status: RegistrationStatus,
  /** Quotable reference (v3/05 §3); null on pre-v2 rows. */
  ref_code: z.string().nullable(),
  display_name: z.string(),
  division_name: z.string(),
  competition_name: z.string(),
  competition_slug: z.string(),
  org_slug: z.string(),
  org_name: z.string(),
  starts_on: z.string().nullable(),
  ends_on: z.string().nullable(),
  fee_cents: z.number().int(),
  amount_cents: z.number().int(),
  currency: z.string().nullable(),
  refunded_cents: z.number().int(),
  /** True when a payment is due and the registrant can (re)open checkout. */
  payment_due: z.boolean(),
  created_at: z.string(),
});

export const PublicRegistrationToken = z.object({ token: z.string().min(10).max(200) });
export type PublicRegistrationToken = z.infer<typeof PublicRegistrationToken>;

// Stripe Connect (org onboarding) --------------------------------------------

export const ConnectStatus = z.object({
  connected: z.boolean(),
  charges_enabled: z.boolean(),
  details_submitted: z.boolean().nullable(),
  payouts_enabled: z.boolean(),
  disabled_reason: z.string().nullable(),
  requirements_due: z.number(),
});

export const CreateConnectOnboarding = z.object({
  /** App-relative path to return to after Stripe onboarding. */
  return_path: z.string().max(300).regex(/^\//, "app-relative path").default("/settings/billing"),
  /** Acceptance of the entry-fee chargeback terms (ToS §5). Required for the
   *  first connect — the Express account is only created once accepted;
   *  resuming onboarding does not re-ask (PROMPT-55). */
  tos_agreed: z.boolean().default(false),
});
export type CreateConnectOnboarding = z.infer<typeof CreateConnectOnboarding>;

export const ConnectOnboardingLink = z.object({ url: z.string() });

// Clubs & bulk import (Jul3/01, PROMPT-21) ------------------------------------

export const Club = z.object({
  id: z.string(),
  name: z.string(),
  short_name: z.string().nullable(),
  logo_path: z.string().nullable(),
  colors: z.record(z.string(), z.string()).nullable(),
  external_ref: z.string().nullable(),
  slug: z.string().nullable(),
  home_ground: z.string().nullable(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
});

export const CreateClub = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().min(1).max(40).optional(),
  colors: z.record(z.string(), z.string()).optional(),
  external_ref: z.string().min(1).max(100).optional(),
  home_ground: z.string().min(1).max(200).optional(),
  website: z.string().url().max(200).optional(),
  notes: z.string().max(2000).optional(),
});
export type CreateClub = z.infer<typeof CreateClub>;

export const PatchClub = z.object({
  name: z.string().min(1).max(200).optional(),
  short_name: z.string().min(1).max(40).nullable().optional(),
  colors: z.record(z.string(), z.string()).nullable().optional(),
  external_ref: z.string().min(1).max(100).nullable().optional(),
  logo_path: z.string().nullable().optional(),
  slug: z.string().min(1).max(80).nullable().optional(),
  home_ground: z.string().min(1).max(200).nullable().optional(),
  website: z.string().url().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});
export type PatchClub = z.infer<typeof PatchClub>;

// Club contacts (W1 §4.2 FA officer model). is_primary is unique per club.
export const ClubContact = z.object({
  id: z.string(), club_id: z.string(), role_key: z.string(),
  full_name: z.string(), email: z.string().nullable(), phone: z.string().nullable(),
  is_primary: z.boolean(), user_id: z.string().nullable(),
  claimed_at: z.string().nullable(), created_at: z.string(),
});
export const CreateClubContact = z.object({
  role_key: z.enum(["secretary", "chairman", "treasurer", "welfare", "manager", "other"]),
  full_name: z.string().min(1).max(200),
  email: z.string().email().max(200).nullable().optional(),
  phone: z.string().min(3).max(40).nullable().optional(),
  is_primary: z.boolean().optional(),
});
export type CreateClubContact = z.infer<typeof CreateClubContact>;
export const PatchClubContact = CreateClubContact.partial();
export type PatchClubContact = z.infer<typeof PatchClubContact>;

// Standalone team create + move/detach (W1 §5.2).
export const CreateTeamStandalone = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().min(1).max(60).optional(),
  club_id: z.string().uuid().optional(),
});
export type CreateTeamStandalone = z.infer<typeof CreateTeamStandalone>;
export const PatchTeam = z.object({ club_id: z.string().uuid().nullable() });
export type PatchTeam = z.infer<typeof PatchTeam>;

export const ClubDetail = Club.extend({
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      short_name: z.string().nullable(),
      logo_path: z.string().nullable(),
      entries: z.array(
        z.object({
          division_id: z.string(),
          entrant_id: z.string(),
          division_name: z.string(),
          competition_id: z.string(),
        }),
      ),
    }),
  ),
  contacts: z.array(ClubContact),
});

export const LogoAssignment = z.object({
  filename: z.string(),
  clubId: z.string().nullable(),
  clubName: z.string().nullable(),
  matchedBy: z.enum(["filename", "manual", "order"]).nullable(),
  logoPath: z.string().nullable(),
});

// The plan itself is the engine's ImportPlan (typed there); the API documents
// it loosely — clients treat it as display data.
export const ImportPreview = z.object({
  importId: z.string(),
  filename: z.string(),
  status: z.enum(["planned", "committed"]),
  rowCount: z.number().int(),
  mapping: z.record(z.string(), z.string()).optional(),
  plan: z.object({
    ops: z.array(z.record(z.string(), z.unknown())),
    stats: z.object({
      clubs: z.number().int(),
      teams: z.number().int(),
      persons: z.number().int(),
      entrants: z.number().int(),
      rosters: z.number().int(),
    }),
    issues: z.array(
      z.object({
        rowNo: z.number().int(),
        column: z.string().optional(),
        severity: z.enum(["error", "warn"]),
        code: z.string(),
        message: z.string(),
      }),
    ),
  }),
});

export const ImportCommitResult = z.object({
  importId: z.string(),
  stats: ImportPreview.shape.plan.shape.stats,
  divisionIds: z.array(z.string()),
});

// Referee & officials assignment (Jul3/02, PROMPT-22) -------------------------

export const Official = z.object({
  id: z.string(),
  person_id: z.string().nullable(),
  entrant_id: z.string().nullable(),
  display_name: z.string(),
  email: z.string().nullable(),
  role_keys: z.array(z.string()),
  home_pool_id: z.string().nullable(),
  max_per_day: z.number().int().nullable(),
  created_at: z.string(),
});

export const CreateOfficial = z.object({
  display_name: z.string().min(1).max(200),
  person_id: Uuid.optional(),
  entrant_id: Uuid.optional(),
  email: z.email().max(200).nullable().optional(),
  role_keys: z.array(z.string().min(1)).min(1).default(["referee"]),
  home_pool_id: Uuid.nullable().optional(),
  max_per_day: z.number().int().positive().nullable().optional(),
});

export const PatchOfficial = CreateOfficial.partial();

// Sponsor CRM (v10 PROMPT-56) -------------------------------------------------

export const SponsorTier = z.enum(["title", "gold", "silver", "partner"]);
export const SponsorStatus = z.enum(["active", "pending", "inactive"]);

export const Sponsor = z.object({
  id: z.string(),
  competition_id: z.string().nullable(),
  name: z.string(),
  url: z.string().nullable(),
  logo_path: z.string().nullable(),
  tier: SponsorTier,
  display_order: z.number().int(),
  status: SponsorStatus,
  click_count: z.number().int(),
  created_at: z.string(),
  /** Set on list reads when a paid package order activated this placement. */
  paid_order_id: z.string().nullable().optional(),
  /** List reads: true while that order carries an open payment dispute — the
   *  placement was parked by the dispute handler and can't be re-activated. */
  dispute_parked: z.boolean().optional(),
  /** List reads: a lost dispute wrote the activating order off — the
   *  placement stays down and this explains why. */
  dispute_lost: z.boolean().optional(),
});

export const CreateSponsor = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().max(500).nullish(),
  logo_path: z.string().max(500).nullish(),
  tier: SponsorTier.default("partner"),
  competition_id: Uuid.nullish(),
  status: SponsorStatus.default("active"),
});

export const PatchSponsor = CreateSponsor.partial();

export const ReorderSponsors = z.object({ ids: z.array(Uuid).min(1).max(200) });

export const SponsorPackage = z.object({
  id: z.string(),
  competition_id: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  price_cents: z.number().int(),
  currency: z.string(),
  tier: SponsorTier,
  active: z.boolean(),
  created_at: z.string(),
});

export const CreateSponsorPackage = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  price_cents: z.number().int().positive().max(5_000_000),
  currency: z.string().length(3).toLowerCase().default("gbp"),
  tier: SponsorTier.default("partner"),
  competition_id: Uuid.nullish(),
});

export const SponsorOrder = z.object({
  id: z.string(),
  package_id: z.string(),
  sponsor_name: z.string(),
  sponsor_email: z.string(),
  payment_intent_id: z.string().nullable(),
  amount_cents: z.number().int(),
  currency: z.string(),
  status: z.enum(["pending", "paid", "failed", "refunded"]),
  sponsor_id: z.string().nullable(),
  created_at: z.string(),
  paid_at: z.string().nullable(),
  disputed_at: z.string().nullable(),
  dispute_id: z.string().nullable(),
});

export const StartSponsorCheckout = z.object({
  package_id: Uuid,
  sponsor_name: z.string().min(1).max(80),
  sponsor_email: z.string().email().max(320),
});

export const SponsorCheckoutStarted = z.object({
  order: SponsorOrder,
  checkout_url: z.string(),
});

// ---------------------------------------------------------------------------
// Officiating portal (PROMPT-57) — assignment responses, blackout dates,
// the official's score link
// ---------------------------------------------------------------------------

export const OfficiatingResponseInput = z.object({
  response: z.enum(["accepted", "declined"]),
  decline_reason: z.string().max(500).nullish(),
});
export type OfficiatingResponseInput = z.infer<typeof OfficiatingResponseInput>;

export const OfficiatingResponseOut = z.object({
  fixture_id: Uuid,
  response: z.enum(["pending", "accepted", "declined"]),
  decline_reason: z.string().nullable(),
});

export const OfficiatingBlackoutInput = z.object({
  date: z.iso.date(),
  note: z.string().max(200).nullish(),
});
export type OfficiatingBlackoutInput = z.infer<typeof OfficiatingBlackoutInput>;

export const OfficiatingBlackout = z.object({
  date: z.string(),
  note: z.string().nullable(),
});

/** POST response only — the pad URL embeds the secret, shown exactly once. */
export const OfficiatingScoreLink = z.object({
  secret: z.string(),
  expires_at: z.string(),
});

/** POST /me/officiating-claims/{id}/accept response (v11.1 — the /me
 *  "Pending invites" card; the list itself is server-rendered, not an
 *  /api/v1 route, so this is the only officiating-claim schema needed). */
export const OfficiatingClaimAccepted = z.object({
  org_name: z.string(),
  official_name: z.string(),
});

const AssignPolicyBody = z.object({
  roles: z.array(z.string().min(1)).min(1),
  poolLock: z.boolean().default(false),
  blockStay: z.boolean().default(false),
  fairness: z.enum(["tournament", "per_day"]).default("tournament"),
  teamRefKeepDivision: z.boolean().default(false),
  restMinMinutes: z.number().int().nonnegative().default(0),
  blockGapMinutes: z.number().int().positive().default(30),
});

export const AutoAssignOfficials = z.object({
  policy: AssignPolicyBody,
  rng_seed: z.string().default("officials"),
});

export const OfficialsProposal = z.object({
  assignments: z.array(
    z.object({
      fixtureId: z.string(),
      officialId: z.string(),
      roleKey: z.string(),
      locked: z.boolean().optional(),
    }),
  ),
  conflicts: z.array(
    z.object({
      kind: z.string(),
      severity: z.enum(["block", "warn"]),
      fixtureId: z.string().optional(),
      officialId: z.string().optional(),
      roleKey: z.string().optional(),
      detail: z.string().optional(),
    }),
  ),
});

export const ApplyOfficials = z.object({
  assignments: z.array(
    z.object({
      fixture_id: Uuid,
      official_id: Uuid,
      role_key: z.string().min(1),
      locked: z.boolean().default(false),
    }),
  ),
  /** Audit provenance when the set came from the AI Officials Architect (v4/03
   *  §10) — shared with ApplyScheduleRequest; merged into officials_assigned. */
  ai: AiApplyMeta.optional(),
});

export const PatchFixtureOfficials = z.object({
  set: z.array(
    z.object({
      official_id: Uuid,
      role_key: z.string().min(1),
      locked: z.boolean().default(false),
    }),
  ),
});

export const SourceOfficials = z.object({
  sources: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("rank"),
          fromStage: z.string(),
          take: z.array(z.object({ poolId: z.string().optional(), rank: z.number().int().positive() })),
        }),
        z.object({
          kind: z.literal("result"),
          fromFixture: z.string(),
          side: z.enum(["winner", "loser"]),
        }),
      ]),
    )
    .min(1),
});

// Schedule undo & versioning (Jul3/03, PROMPT-23) -----------------------------

export const HistoryStep = z.object({
  /** Optimistic token: the division seq the client last saw (409 on stale). */
  expected_seq: z.number().int().optional(),
});

export const CreateCheckpoint = z.object({
  label: z.string().min(1).max(120),
  /** V303. Omitted = "manual": an organiser's own save point, counted against
   *  schedule.checkpoints.max. "ai" is the undo anchor the AI accept flow
   *  creates on their behalf, and is exempt from that quota. */
  kind: z.enum(["manual", "ai"]).optional(),
});

export const RestoreCheckpoint = z.object({
  checkpoint_id: Uuid,
  confirm: z.literal(true),
});

export const DivisionLocks = z.object({
  schedule_locked: z.boolean().optional(),
  locked_scopes: z
    .array(
      z.object({
        courts: z.array(z.string()).optional(),
        venues: z.array(z.string()).optional(),
        pool_ids: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export const ClearSchedule = z.object({
  division_id: Uuid,
  scope: z
    .object({
      stageId: z.string().optional(),
      poolIds: z.array(z.string()).optional(),
      rounds: z.array(z.number().int()).optional(),
      courts: z.array(z.string()).optional(),
      excludeLocked: z.boolean().default(true),
    })
    .default({ excludeLocked: true }),
  confirm: z.literal(true),
});

export const ClearPoolEntrants = z.object({ confirm: z.literal(true) });

// Scheduling constraints v2 & AI (Jul3/04, PROMPT-24) -------------------------

export const ScheduleShift = z.object({
  division_id: Uuid,
  scope: z
    .object({
      stageId: z.string().optional(),
      poolIds: z.array(z.string()).optional(),
      courts: z.array(z.string()).optional(),
      excludeLocked: z.boolean().default(true),
    })
    .default({ excludeLocked: true }),
  delta_minutes: z.number().int().min(-1440).max(1440),
});

// Token-weighted AI credit rung (lib/ai-rung.ts, issue #348).
const RungLiteral = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/**
 * What an AI run cost and what that bought, spread into every AI response so
 * the confirm card reads one shape whatever endpoint answered it. Mirrors
 * `RunMeterStamp` in lib/ai-rung.ts — the single builder both phases (and #350's
 * joint solve) stamp their ledger event and response with.
 *
 * Optional so fixtures and clients written before this field set still satisfy
 * the type; every real response sends `credits`, `budget`, `spent_tokens`,
 * `underfunded`, `stopped_on_budget` and `est_tokens`. `rung`/`predicted_rung`
 * are the single-division flat form; `divisions`/`discount` the joint form.
 */
const AiRunPriceFields = {
  /** Credits actually charged (after any joint batch discount). */
  credits: z.number().int().optional(),
  /** Hard generation-token budget those credits bought. */
  budget: z.number().int().optional(),
  /** Generation tokens the run actually spent. */
  spent_tokens: z.number().int().optional(),
  /** Advisory pre-run estimate the confirm card showed. */
  est_tokens: z.number().int().optional(),
  /** A rung below the prediction was chosen. */
  underfunded: z.boolean().optional(),
  /** The run ended because the budget ran out, not because it was done. */
  stopped_on_budget: z.boolean().optional(),
  /** Single-division form. */
  rung: RungLiteral.optional(),
  predicted_rung: RungLiteral.optional(),
  /** Joint (multi-division) form — issue #350. */
  discount: z.number().int().optional(),
  divisions: z
    .array(
      z.object({
        id: z.string(),
        rung: RungLiteral,
        predicted_rung: RungLiteral,
        underfunded: z.boolean(),
      }),
    )
    .optional(),
};

// v4 AI Schedule Architect (design/v4/00-03) — Phase A propose-only endpoint.
// The model proposes times+courts; the engine verifier is authoritative. This
// contract carries the request instruction, an optional repair scope, an
// optional prior proposal (refine), and an optional officials policy for a dry
// coverage preview (no LLM). `officials_policy` reuses the officials-auto body.
export const AiPlanRequest = z.object({
  instruction: z.string().min(3).max(4000),
  mode: z.enum(["generate", "refine", "repair"]).default("generate"),
  scope: z
    .object({
      from: IsoDateTime.optional(),
      courts: z.array(z.string()).optional(),
      pool_ids: z.array(Uuid).optional(),
    })
    .optional(),
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({ fixture_id: Uuid, scheduled_at: z.string(), court_label: z.string() }),
      ),
    })
    .optional(),
  officials_policy: AssignPolicyBody.optional(),
  // Token-weighted AI credit rung (lib/ai-rung.ts): defaults to the server
  // prediction when omitted. A caller may pick below the prediction — the run
  // still executes, capped to the chosen rung's token budget, and the ledger
  // stamps `underfunded: true`.
  rung: RungLiteral.optional(),
  /**
   * W5 (#400): the confirmed compile from `POST .../schedule/ai-preview`. When
   * present the run reuses that stored parse instead of compiling a second
   * time, so the rules the organiser approved are the rules the architect
   * executes under — and a `preview_id` whose stored instruction no longer
   * matches this request's is a 409 `preview_stale` rather than a silent
   * recompile.
   *
   * OPTIONAL, and it must stay that way: smoke, the e2e API paths and every
   * external consumer post a run without one, and compile inline exactly as
   * they always have.
   */
  preview_id: Uuid.optional(),
});
export type AiPlanRequest = z.infer<typeof AiPlanRequest>;

const AiPlanAssignment = z.object({
  fixture_id: Uuid,
  scheduled_at: z.string(),
  court_label: z.string(),
  schedule_locked: z.boolean().optional(),
});

// Engine verifier conflict (camelCase, @seazn/engine/scheduling Conflict).
const AiPlanConflict = z.object({
  fixtureId: z.string(),
  reason: z.string(),
  detail: z.string().optional(),
  direct: z.boolean().optional(),
  /** The rule the prompt taught for this reason (#399), so a repair round is
   *  handed the token it knows instead of a word we invented. Declared here or
   *  zod strips it and the model goes back to interpreting prose. */
  rule: RuleCode.optional(),
  /** How short a measured breach falls, in minutes — the number a repair round
   *  needs to know how far to move the card (#399). */
  shortfallMinutes: z.number().int().optional(),
});

// A durable constraints delta the architect inferred from the instruction —
// the ENGINE constraints family, but with startWindow bounds converted from
// epoch ms to ISO-with-offset in the division timezone (the shape clients + the
// schedule-settings PUT speak). Mirrors ScheduleConfig.constraints, all fields
// optional (it is a suggestion delta).
const AiConstraintSuggestions = z.object({
  restMin: z.number().int().min(0).max(24 * 60).optional(),
  restByGroup: z.record(z.string(), z.number().int().min(0).max(24 * 60)).optional(),
  noBackToBack: z.boolean().optional(),
  startWindows: z
    .array(
      z.object({
        target: z.object({ kind: z.enum(["entrant", "pool", "division"]), id: z.string() }),
        notBefore: IsoDateTime.optional(),
        notAfter: IsoDateTime.optional(),
      }),
    )
    .optional(),
  fieldFairness: z.enum(["off", "balance", "rotate"]).optional(),
  parallelism: z.enum(["block", "mixed"]).optional(),
  crossPersonClash: z.enum(["warn", "hard"]).optional(),
});

/**
 * W6 (#401): how a schedule reached its final state.
 *
 * `engine` is the headline and the rest is why. `"none"` means no repair changed
 * the board — it verified clean, or repair was attempted and nothing was
 * adopted. `"z3"` means the automatic solver fixed it, for no credits and no
 * model call. `"llm"` means the assistant was asked to repair it.
 *
 * The rest of the object exists because #401 requires the FALLBACK to be
 * visible, not merely correct: a run where the solver timed out, was queued
 * behind another run, or came back with families it could not satisfy must say
 * which, or "we tried and gave up" is indistinguishable from "we never tried".
 *
 * Every field but `engine` and `solver_ran` is optional, because most of them
 * are facts only a completed solve produces. Kept OPEN (a plain object rather
 * than a closed union) so a new diagnostic is an additive change — the same
 * reason `usage` is shaped this way.
 */
export const AiRepairReport = z.object({
  engine: z.enum(["none", "z3", "llm"]),
  /** Did the WASM solver actually run? False on the clean path, and on both
   *  paths where the attempt was declined before it started. */
  solver_ran: z.boolean(),
  status: z.enum(["clean", "repaired", "partial", "unrepaired"]).optional(),
  /** `k` — the number of fixtures moved. */
  moved: z.number().int().nonnegative().optional(),
  /** Wall-clock the request paid, queue wait included. */
  ms: z.number().int().nonnegative().optional(),
  checks: z.number().int().nonnegative().optional(),
  /** `upper_bound` means `moved` is the fewest this decomposition found, not the
   *  fewest that exist. Never rendered as "minimal" unless this says `proved`. */
  minimality: z.enum(["proved", "upper_bound"]).optional(),
  components_solved: z.number().int().nonnegative().optional(),
  components_skipped: z.number().int().nonnegative().optional(),
  /** Fixtures the solver left for the assistant. */
  unresolved: z.number().int().nonnegative().optional(),
  /** Conflicts the board still carries, blocking or not. */
  residual: z.number().int().nonnegative().optional(),
  /** Constraint families a component dropped to find any answer at all. */
  relaxed: z.array(z.string()).optional(),
  /** Families that cannot hold together — "no schedule can satisfy all of
   *  these at once". */
  families: z.array(z.string()).optional(),
  timed_out: z.boolean().optional(),
  fallback: z
    .enum([
      "disabled",
      "queue_wait",
      "budget",
      "partial",
      "unrepaired",
      "error",
      "not_adopted",
      "court_split",
    ])
    .optional(),
});
export type AiRepairReport = z.infer<typeof AiRepairReport>;

export const AiPlanResponse = z.object({
  proposal: z.array(AiPlanAssignment),
  unschedulable: z.array(z.object({ fixture_id: Uuid, reason: z.string(), rule: RuleCode })),
  warnings: z.array(AiPlanConflict),
  blocking: z.array(AiPlanConflict),
  diff: z.object({
    moved: z.array(z.string()),
    placed: z.array(z.string()),
    unscheduled: z.array(z.string()),
    unchanged: z.array(z.string()),
  }),
  explanations: z.array(z.object({ fixture_id: Uuid, note: z.string() })),
  constraint_suggestions: AiConstraintSuggestions.optional(),
  summary: z.string(),
  /**
   * The ARCHITECT's own assumptions (stage 2, model-authored): what it assumed
   * while placing. NOT the resolver's — those are stage 1, deterministic, and
   * ride on `AiParsePreviewResponse.compiled.assumptions`, shown before a credit
   * is spent. Two different arrays in two different responses; merging them
   * would tell the organiser the machine assumed something it did not.
   *
   * `.default([])` rather than `.optional()`: the prompt schema makes the field
   * optional and the model omits it routinely, while the review panel maps over
   * it. `undefined` here is a client crash, not a cosmetic gap.
   */
  assumptions: z.array(z.string()).default([]),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  /** W6 (#401): which engine repaired this board, and what the automatic one
   *  did or could not do. */
  repair: AiRepairReport,
  /** Dry officials coverage preview (present only when officials_policy sent). */
  officials_coverage: z
    .object({
      fillable: z.number().int(),
      total: z.number().int(),
      unfilled: z.array(z.object({ fixture_id: z.string(), role_key: z.string() })),
    })
    .nullable(),
  ...AiRunPriceFields,
});
export type AiPlanResponse = z.infer<typeof AiPlanResponse>;

// v4 AI Schedule Architect — Phase B (officials architect, design/v4/03 §2). The
// model assigns officials to a dry-run (or the current) schedule; the engine
// referee is authoritative and nothing is written. `instruction` may be empty —
// then the deterministic solver draft is returned with no LLM call. `policy`
// reuses the officials-auto body; `prior.assignments` mirror the response
// `assignments` (engine FixtureOfficial, camelCase) so a refine turn round-trips.
export const AiOfficialsPlanRequest = z.object({
  instruction: z.string().max(2000).default(""),
  schedule: z
    .array(z.object({ fixture_id: Uuid, scheduled_at: IsoDateTime, court_label: z.string() }))
    .optional(),
  policy: AssignPolicyBody,
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({
          fixtureId: Uuid,
          officialId: Uuid,
          roleKey: z.string().min(1),
          locked: z.boolean().optional(),
        }),
      ),
    })
    .optional(),
  // Token-weighted AI credit rung (lib/ai-rung.ts): defaults to the server
  // prediction when omitted; see AiPlanRequest.rung for the full contract.
  // Ignored on the empty-instruction path, which makes no model call and is
  // always priced at 1 credit.
  rung: RungLiteral.optional(),
});
export type AiOfficialsPlanRequest = z.infer<typeof AiOfficialsPlanRequest>;

// Engine-taxonomy conflict (camelCase, @seazn/engine/officials OfficialConflict)
// plus the server-side "ineligible" verdict; `severity` flags the blocking ones.
const AiOfficialsConflict = z.object({
  kind: z.string(),
  severity: z.enum(["block", "warn"]),
  fixtureId: z.string().optional(),
  officialId: z.string().optional(),
  roleKey: z.string().optional(),
  detail: z.string().optional(),
});

export const AiOfficialsPlanResponse = z.object({
  // Proposed assignments (engine FixtureOfficial). Locked rows are echoed with
  // locked:true; the empty-instruction path returns the solver draft verbatim.
  assignments: z.array(
    z.object({
      fixtureId: z.string(),
      officialId: z.string(),
      roleKey: z.string(),
      locked: z.boolean().optional(),
    }),
  ),
  conflicts: z.array(AiOfficialsConflict),
  diff: z.object({
    // Fixture ids whose assignment set differs from / matches the baseline
    // (the prior proposal when given, else the locked assignments).
    changed: z.array(z.string()),
    unchanged: z.array(z.string()),
    // Slots the plan could not fill, each with the model's short reason.
    unfilled: z.array(z.object({ fixture_id: z.string(), role_key: z.string(), reason: z.string() })),
  }),
  // Declared-unfilled slots the referee's solver CAN fill, with a candidate — a
  // suggestion the organiser may accept (design/v4/03 §7 decision 8).
  lazy_unfilled: z.array(
    z.object({ fixture_id: z.string(), role_key: z.string(), candidate_official_id: z.string() }),
  ),
  explanations: z.array(z.object({ fixture_id: z.string(), note: z.string() })),
  summary: z.string(),
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  ...AiRunPriceFields,
});
export type AiOfficialsPlanResponse = z.infer<typeof AiOfficialsPlanResponse>;

// ---------------------------------------------------------------------------
// #350 Multi-division JOINT AI scheduling — POST /competitions/{id}/schedule/
// ai-plan. One model call over several divisions of one competition, priced as
// a batch. The orchestrator is `aiPlanForCompetition`
// (server/usecases/competition-schedule-ai.ts); these are the wire contracts.
// ---------------------------------------------------------------------------

export const AiCompetitionPlanRequest = z.object({
  /**
   * The divisions to solve together. The **>= 2 rule is deliberately NOT a
   * `.min(2)` here** — it is the orchestrator's, which answers 400
   * `AI_PLAN_SINGLE_DIVISION`.
   *
   * Zod cannot be the authority for it in either direction. It is not
   * sufficient: `[d, d]` is two array entries and one division, and a division
   * with nothing movable is DROPPED before the quote (ruling R6), so a
   * three-id request can legitimately arrive at one solvable division. And it
   * is not necessary: the orchestrator already de-duplicates and re-checks
   * after the drop. Two mechanisms for one rule would also give the client two
   * different 400s for the same mistake — a `VALIDATION` blob of zod issues,
   * or the code the board renders "use the division schedule page" from.
   *
   * The ceiling stays here: 20 is a shape limit, and nothing downstream needs
   * to have loaded a competition to enforce it.
   */
  division_ids: z.array(Uuid).min(1).max(20),
  instruction: z.string().min(1).max(2000),
  mode: z.enum(["generate", "refine", "repair"]).default("generate"),
  /** Per-division rung override from the confirm card's segmented control.
   *  Advisory — the server always recomputes the quote, and an entry naming a
   *  division outside the run is ignored rather than rejected. */
  rung_overrides: z.record(Uuid, RungLiteral).optional(),
  prior: z
    .object({
      instruction: z.string(),
      assignments: z.array(
        z.object({
          fixture_id: Uuid,
          scheduled_at: IsoDateTime,
          court_label: z.string(),
          division_id: Uuid,
        }),
      ),
    })
    .optional(),
  /** W5 (#400): the confirmed compile from `POST .../schedule/ai-preview`. The
   *  joint twin of {@link AiPlanRequest.preview_id}, and scoped the same way —
   *  a preview taken against ONE division is refused here, because its window
   *  was resolved from a different fixture count than this run's. */
  preview_id: Uuid.optional(),
});
export type AiCompetitionPlanRequest = z.infer<typeof AiCompetitionPlanRequest>;

export const AiCompetitionPlanResponse = z.object({
  /** Every slot names the division the SERVER resolved it to — JOINT_RULES
   *  tells the model not to emit one, so this is never an echo. */
  proposal: z.array(
    z.object({
      fixture_id: z.string(),
      scheduled_at: z.string(),
      court_label: z.string(),
      division_id: z.string(),
      schedule_locked: z.boolean().optional(),
    }),
  ),
  unschedulable: z.array(z.object({ fixture_id: z.string(), reason: z.string(), rule: RuleCode })),
  // The ENGINE verifier's camelCase Conflict, exactly as the single-division
  // AiPlanResponse carries it — NOT the snake_case ScheduleConflict of the
  // apply/validate endpoints. The orchestrator returns `Conflict[]` verbatim,
  // so declaring the other shape here would strip every field of every warning
  // and publish a contract the route does not honour.
  warnings: z.array(AiPlanConflict),
  blocking: z.array(AiPlanConflict),
  diff: z.object({
    moved: z.array(z.string()),
    placed: z.array(z.string()),
    unscheduled: z.array(z.string()),
    unchanged: z.array(z.string()),
  }),
  explanations: z.array(z.object({ fixture_id: z.string(), note: z.string() })),
  summary: z.string(),
  /** The ARCHITECT's own assumptions (stage 2), exactly as
   *  {@link AiPlanResponse.assumptions} carries them — never the resolver's,
   *  which are stage 1 and ride on the preview response. `.default([])` because
   *  the model omits the key routinely and the review panel maps over it. */
  assumptions: z.array(z.string()).default([]),
  /** Court labels not shared by every solved division. Cross-division court
   *  identity is a string match and nothing else, so the board warns. */
  divergent_courts: z.array(z.string()),
  /** Requested divisions dropped before quoting (ruling R6) — the organiser is
   *  told why a division they picked is missing rather than silently getting a
   *  smaller board back. */
  skipped_divisions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      reason: z.literal("no_movable_fixtures"),
    }),
  ),
  /** Public shape only — `cost_usd` stays on the ledger event. */
  usage: z.object({
    input_tokens: z.number().int(),
    output_tokens: z.number().int(),
    repair_rounds: z.number().int(),
  }),
  /** W6 (#401): the joint solve runs ONCE over the whole board, so this is one
   *  report for the competition, never one per division. */
  repair: AiRepairReport,
  // ---------------------------------------------------------------------
  // ORDER IS LOAD-BEARING. `AiRunPriceFields` declares its own `divisions`
  // key — the meter stamp's per-division PRICE rows — and the override below
  // MUST come after it. A joint response carries ONE `divisions` array
  // holding both those price rows and the board's picker data (the division's
  // name and movable count), exactly as `aiPlanForCompetition` builds it:
  // two sibling arrays over one key would be a join every client redoes on
  // every render.
  //
  // The two directions are NOT symmetric — measured, not assumed:
  //
  //   * Swapping this order (spread AFTER the override) does NOT compile:
  //     1 x TS2783 "'divisions' is specified more than once", plus 4 x TS2339
  //     and 7 x TS18048 knock-on. The wrong order cannot ship, and `tsc` is a
  //     real net for THAT mistake specifically.
  //   * The order as written is the SILENT one. Any later edit that keeps the
  //     shapes structurally compatible — dropping a key from the merged row,
  //     letting the two arrays drift apart — passes `tsc` clean, and Zod does
  //     not error either: it STRIPS the keys the winning schema does not
  //     declare, so `name`/`movable` (or `rung`/`predicted_rung`) simply
  //     vanish from a 200 response with no exception and no warning.
  //
  // Neither this comment nor an assertion on `divisions.length` catches the
  // silent case. The guard is competition-schedule-ai-http.test.ts, which
  // asserts BOTH sets of fields survive one parse of a real orchestrator
  // result.
  // ---------------------------------------------------------------------
  ...AiRunPriceFields,
  divisions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      movable: z.number().int(),
      rung: RungLiteral,
      predicted_rung: RungLiteral,
      underfunded: z.boolean(),
    }),
  ),
});
export type AiCompetitionPlanResponse = z.infer<typeof AiCompetitionPlanResponse>;

// ---------------------------------------------------------------------------
// W5 (#400) — the parse-only preview that precedes either run
// ---------------------------------------------------------------------------

/**
 * POST /divisions/{id}/schedule/ai-preview and
 * POST /competitions/{id}/schedule/ai-preview.
 *
 * One request body for both routes. It runs stage 1 ONLY — the instruction
 * compile — and returns what was compiled without spending a credit or calling
 * the architect, so the organiser can see the rules before paying for a run
 * against them. Declining is a client no-op.
 */
export const AiParsePreviewRequest = z.object({
  instruction: z.string().min(1).max(2000),
  /** Joint route only: the divisions in scope, so the resolver reads the same
   *  window the run will. Omitted on the single-division route, where the
   *  division is the path parameter. */
  division_ids: z.array(Uuid).optional(),
  /** Single-division route only. Advisory, exactly as on {@link AiPlanRequest} —
   *  it is here so the affordability refusal below prices the SAME run the
   *  confirm will start. Without it a rung-3 run would be previewed against a
   *  rung-1 floor and an org that cannot pay would be compiled for anyway. */
  rung: RungLiteral.optional(),
  /** Joint route only. The twin of `rung`, per {@link AiCompetitionPlanRequest}. */
  rung_overrides: z.record(Uuid, RungLiteral).optional(),
});
export type AiParsePreviewRequest = z.infer<typeof AiParsePreviewRequest>;

export const AiParsePreviewResponse = z.object({
  /** Reuse token for the run. ABSENT when the compile failed schema twice —
   *  there is nothing to confirm then, only a fallback to choose. */
  preview_id: Uuid.optional(),
  /** True when stage 1 failed schema twice. The client must offer the explicit
   *  preference fallback and must NEVER fall back on its own: presenting a rule
   *  as enforced while nothing enforces it is the failure this wave closes. */
  failed: z.boolean(),
  compiled: z.object({
    /** Engine constraints, already resolved against the org clock — the rules
     *  the referee will actually check. */
    hard: z.array(HardConstraint),
    soft: z.array(
      z.object({ note: z.string(), weight: z.union([z.literal(1), z.literal(2), z.literal(3)]) }),
    ),
    /** Verbatim. Never converted into a rule. Carries the whole instruction back
     *  when `failed` is true, so the card always has something honest to show. */
    unparsed: z.array(z.string()),
    /** RESOLVER assumptions (stage 1, deterministic, pre-credit) — how we read
     *  the window and the weekdays. NOT the architect's own assumptions, which
     *  are stage 2 and ride on the plan response. The two are different arrays
     *  and must never be merged. */
    assumptions: z.array(z.string()),
  }),
  /** The calendar window the INSTRUCTION stated, in the org timezone, as
   *  YYYY-MM-DD — null when it stated none.
   *
   *  Null rather than the run's default window on purpose: the default is
   *  computed by the pack builder from settings, already-scheduled instants and
   *  session windows, and there is exactly one writer of it
   *  (`buildSchedulePack`). Recomputing a second copy here to fill this field
   *  would be a renderer that can drift from the one the run uses. */
  window: z.object({ start: z.string(), end: z.string(), tz: z.string() }).nullable(),
  /** When this preview stops being reusable. A stale preview is stale by
   *  wall-clock as well as by content: the org's clock may have crossed a day
   *  boundary, and "tomorrow" with it. */
  expires_at: IsoDateTime,
});
export type AiParsePreviewResponse = z.infer<typeof AiParsePreviewResponse>;

/**
 * GET /competitions/{id}/schedule/ai-last — the joint mirror of
 * {@link AiLastResult}, field for field.
 *
 * A recall of the last APPLIED plan, not of the last proposal. An AI plan is
 * propose-only and nothing about it is written down unless the organiser
 * applies it — that has been true of the single-division board since v4, and it
 * is why this is the twin's shape rather than a partial plan response. `last`
 * stays null until a joint apply exists (#350 Task 6); `runs.used` counts joint
 * runs on the competition, and `max` is null because joint runs are metered by
 * the credit wallet rather than by a run quota. See `lastCompetitionAiApply`.
 *
 * Declared separately from `AiLastResult` rather than reusing it: the two
 * endpoints count different events and are free to diverge, and `at` is pinned
 * to an ISO instant here where the older schema left it a bare string.
 */
export const AiCompetitionLastResult = z.object({
  last: z.object({ at: IsoDateTime, instruction: z.string(), summary: z.string() }).nullable(),
  runs: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
});
export type AiCompetitionLastResult = z.infer<typeof AiCompetitionLastResult>;

/**
 * POST /competitions/{id}/schedule/apply — persist a joint plan across several
 * divisions ATOMICALLY (#350 Task 6, spec §8). One transaction writes every
 * division's board or none of it; the per-stage endpoint cannot do this, and
 * calling it in a loop leaves half a board written on any mid-flight failure.
 */
export const ApplyCompetitionScheduleRequest = z.object({
  divisions: z
    .array(
      z.object({
        division_id: Uuid,
        /** REQUIRED here, unlike the per-stage apply's optional token: a joint
         *  write that skipped the check on one division would let a stale board
         *  silently overwrite a concurrent edit there while every other
         *  division was guarded. */
        expected_seq: z.number().int().nonnegative(),
        assignments: z
          .array(
            z
              .object({
                fixture_id: Uuid,
                scheduled_at: IsoDateTime,
                court_label: z.string().min(1).max(100),
              })
              /**
               * `.strict()`, because the plan's own output is WIDER than this.
               * `AiCompetitionPlanResponse.proposal` carries an optional
               * `schedule_locked` (see above), and zod STRIPS unknown keys — so
               * a plan asking to pin a fixture would apply 200 with no pin, and
               * two schemas of one feature would disagree in silence. Strict
               * makes that a loud 400.
               *
               * Deliberately not "support pinning": accepting the field would
               * need the `scheduling.board` gate the per-stage apply puts on pin
               * changes (schedule.ts:485-487). Nothing sends it today, so this
               * costs no capability and leaves Task 7 free to add pinning as a
               * decision rather than inherit it as an accident.
               */
              .strict(),
          )
          .min(1)
          .max(500),
      }),
    )
    /**
     * `.min(1)`, NOT `.min(2)` — and that is not an oversight.
     *
     * The >= 2 rule on the PLAN endpoint exists to stop discount arbitrage: a
     * joint run is priced at max(1, sum of rungs - 1), so a one-division "joint"
     * run would buy a single-division solve at a discount. Applying costs
     * nothing. Refusing a one-division apply would only mean the board had to
     * decide, per outcome, which of two endpoints to post an already-paid-for
     * plan to — and ruling R6 lets a run legitimately end up with fewer solved
     * divisions than were requested.
     *
     * The ceiling matches the plan request's, since one apply can never span
     * more divisions than one run planned.
     */
    .min(1)
    .max(20),
  /** "ai" only. Manual board edits stay on the per-stage endpoint: a hand edit
   *  is one division by construction. */
  source: z.literal("ai"),
  /** Audit provenance (v4/03 §10) — stamped into every division's
   *  `schedule_applied` row AND the one `schedule.applied_multi` row that
   *  GET /competitions/{id}/schedule/ai-last recalls. `model` is overwritten
   *  server-side with the model that actually ran. */
  ai: AiApplyMeta.optional(),
});
export type ApplyCompetitionScheduleRequest = z.infer<typeof ApplyCompetitionScheduleRequest>;

export const ApplyCompetitionScheduleResult = z.object({
  applied: z.number().int(),
  /** The ENGINE verifier's camelCase `Conflict`, exactly as the joint ai-plan
   *  response carries it — NOT the snake_case `ScheduleConflict` of the
   *  per-stage apply. `applyCompetitionSchedule` returns `Conflict[]` verbatim,
   *  so declaring the other shape here would strip every field of every warning
   *  down to `{}` and publish a contract the route does not honour. */
  conflicts: z.array(AiPlanConflict),
});
export type ApplyCompetitionScheduleResult = z.infer<typeof ApplyCompetitionScheduleResult>;

// Custom points & rank control (Jul3/05, PROMPT-25) ---------------------------

export const OverrideStandings = z.object({
  rows: z
    .array(
      z.object({
        entrant_id: Uuid,
        rank: z.number().int().min(1),
        reason: z.string().min(1).max(300),
      }),
    )
    .min(1)
    .max(64),
});
export type OverrideStandings = z.infer<typeof OverrideStandings>;

// Format extensions (Jul3/08, PROMPT-28) --------------------------------------

export const LadderChallenge = z.object({
  challenger_id: Uuid,
  opponent_id: Uuid,
});

// Discipline & suspensions (SPEC-1 / PROMPT-78) -------------------------------
// Colours are validated against the sport module's declared keys at the
// usecase (SPEC-1), not here — zod only enforces shape.

export const SuspensionStatus = z.enum(["pending", "active", "served", "waived"]);

const AccumulationRule = z.object({
  key: z.string().min(1),
  color: z.string().min(1),
  count: z.number().int().positive(),
  ban_matches: z.number().int().positive(),
});
const DismissalRule = z.object({
  key: z.string().min(1),
  color: z.string().min(1),
  ban_matches: z.number().int().positive(),
});
export const DisciplineRulesDoc = z.object({
  accumulation: z.array(AccumulationRule),
  dismissal: z.array(DismissalRule),
});

export const PutDisciplineRules = z.object({
  enabled: z.boolean(),
  rules: DisciplineRulesDoc,
});

export const DisciplineRulesResponse = z
  .object({
    enabled: z.boolean(),
    rules: DisciplineRulesDoc,
    sportColors: z.array(z.object({ key: z.string(), label: z.string() })),
  })
  .nullable();

export const CreateSuspension = z.object({
  person_id: Uuid,
  matches_total: z.number().int().min(1),
  reason: z.string().min(1).max(300),
});

export const DecideSuspension = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirm") }),
  z.object({ kind: z.literal("waive") }),
  z.object({
    kind: z.literal("adjust"),
    matches_total: z.number().int().min(1).optional(),
    reason: z.string().min(1).max(300).optional(),
  }),
]);

export const Suspension = z.object({
  id: Uuid,
  divisionId: Uuid,
  personId: Uuid,
  personName: z.string(),
  entrantId: Uuid.nullable(),
  entrantName: z.string().nullable(),
  status: SuspensionStatus,
  source: z.enum(["auto_accumulation", "auto_dismissal", "manual", "report"]),
  reason: z.string(),
  matchesTotal: z.number().int(),
  matchesServed: z.number().int(),
  fixtureId: Uuid.nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  triggerVoided: z.boolean(),
});

// Official marks & match reports (SPEC-3 / PROMPT-80) --------------------------

export const PutMarkBody = z.object({
  mark: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

export const MarkSummary = z.object({
  average: z.number().nullable(),
  count: z.number().int(),
  recent: z.array(
    z.object({
      mark: z.number().int(),
      comment: z.string().nullable(),
      fixtureLabel: z.string(),
      createdAt: z.string(),
    }),
  ),
});

export const IncidentKind = z.enum(["red_card", "misconduct", "injury", "other"]);

export const ReportIncident = z.object({
  kind: IncidentKind,
  person_id: Uuid.optional(),
  entrant_id: Uuid.optional(),
  note: z.string().min(1).max(2000),
});

export const PutReportBody = z.object({
  body: z.string().max(5000),
  incidents: z.array(ReportIncident).max(50),
});

export const MatchReport = z.object({
  id: Uuid,
  fixtureOfficialId: Uuid,
  status: z.enum(["draft", "submitted"]),
  body: z.string(),
  incidents: z.array(ReportIncident),
  submittedAt: z.string().nullable(),
});

export const FixtureReport = MatchReport.extend({ officialName: z.string() });

export const FixtureSquadMember = z.object({
  person_id: Uuid,
  full_name: z.string(),
  entrant_id: Uuid,
  entrant_name: z.string(),
});

// Org news (SPEC-2 / PROMPT-82) -----------------------------------------------

export const PostKind = z.enum(["news", "result", "round_recap", "announcement"]);
export const PostStatus = z.enum(["draft", "published", "archived"]);

export const CreatePost = z.object({
  title: z.string().min(1).max(300),
  body_md: z.string().max(50_000).optional(),
  kind: PostKind.optional(),
  competition_id: Uuid.optional(),
  division_id: Uuid.optional(),
  hero_image_path: z.string().max(500).optional(),
});
export type CreatePost = z.infer<typeof CreatePost>;

export const PatchPost = z
  .object({
    title: z.string().min(1).max(300),
    body_md: z.string().max(50_000),
    hero_image_path: z.string().max(500).nullable(),
    competition_id: Uuid.nullable(),
    division_id: Uuid.nullable(),
    /** Lifecycle: publish stamps published_at + freezes the slug; archive hides. */
    action: z.enum(["publish", "archive"]),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, "empty patch");
export type PatchPost = z.infer<typeof PatchPost>;

// House convention: every /api/v1 response is snake_case (see auto_posts on
// Division, org_id on Competition, module_version on Fixture). The usecase
// layer (org-posts.ts) stays camelCase for server components — routes
// translate at the boundary via toApiPost() in posts.ts.
export const OrgPost = z.object({
  id: Uuid,
  org_id: Uuid,
  competition_id: Uuid.nullable(),
  division_id: Uuid.nullable(),
  kind: PostKind,
  status: PostStatus,
  slug: z.string(),
  title: z.string(),
  body_md: z.string(),
  hero_image_path: z.string().nullable(),
  auto_source: z.record(z.string(), z.unknown()).nullable(),
  published_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
