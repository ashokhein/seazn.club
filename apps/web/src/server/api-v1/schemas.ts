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
// Doc 12 §1: 'scheduled' = timetable published, scoring not yet open.
export const DivisionStatus = z.enum(["setup", "scheduled", "active", "completed"]);
export const StageKind = z.enum(["league", "group", "swiss", "knockout", "double_elim", "stepladder", "americano", "ladder"]);
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
    /** Markdown (v3/06 §2), shown on the public division page. */
    description: z.string().max(20_000).nullable(),
    eligibility: z.array(z.record(z.string(), z.unknown())),
    tiebreakers: z.array(z.string()).nullable(),
    status: DivisionStatus,
    /** Hide official names on all public reads (Jul3/02, 25 Jun). */
    officials_hide_names: z.boolean(),
    /** Jul3/04 §4: 'flexible' = ordered fixtures, no clock. */
    scheduling_mode: z.enum(["timed", "flexible"]),
    /** Jul3/08 §5: progression fires without a button (Pro formats.advanced). */
    auto_progress: z.boolean(),
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
  tiebreakers: z.array(z.string()).nullable(),
  status: DivisionStatus,
  officials_hide_names: z.boolean(),
  scheduling_mode: z.enum(["timed", "flexible"]),
  auto_progress: z.boolean(),
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

export const CreateEntrant = z
  .object({
    kind: EntrantKind,
    // Optional when enrolling an existing team: the server snapshots the name
    // from teams.name at creation so a later rename never rewrites history.
    display_name: z.string().min(1).max(200).optional(),
    team_id: Uuid.nullish(),
    seed: z.number().int().min(1).nullish(),
    members: z.array(EntrantMemberInput).default([]),
    // Copy the roster from an earlier entrant of the SAME team (season rollover,
    // league + cup). Resolved server-side in the creation transaction.
    copy_roster_from_entrant_id: Uuid.nullish(),
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
  home_entrant_id: Uuid.nullable(),
  away_entrant_id: Uuid.nullable(),
  scheduled_at: z.string().nullable(),
  venue: z.string().nullable(),
  court_label: z.string().nullable(),
  officials: z.array(z.unknown()),
  status: z.enum(["scheduled", "in_play", "decided", "finalized", "abandoned", "forfeited", "cancelled"]),
  outcome: z.unknown().nullable(),
  schedule_source: z.enum(["none", "auto", "manual"]),
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
    })
    .optional(),
});
export type ScheduleConfig = z.infer<typeof ScheduleConfig>;

export const PutScheduleSettings = z.object({
  config: ScheduleConfig,
  /** Venue-local timezone (doc 12 §6 — DST boundaries in sessionWindows). */
  tz: z.string().min(1).max(64).default("UTC"),
});
export type PutScheduleSettings = z.infer<typeof PutScheduleSettings>;

export const ScheduleSettings = z.object({
  division_id: Uuid,
  config: ScheduleConfig,
  tz: z.string(),
  updated_at: z.string(),
});

/** Doc 12 §2 conflict taxonomy. `blocking` = conflict.court, or warn.order on
 *  a direct feed; blocked writes are rejected, warnings persist as badges. */
export const ScheduleConflict = z.object({
  fixture_id: Uuid,
  code: z.enum([
    "conflict.court",
    "conflict.start_window",
    "warn.rest",
    "warn.person_overlap",
    "warn.order",
    "warn.blackout",
    "warn.no_slot",
  ]),
  blocking: z.boolean(),
  detail: z.string().optional(),
});
export type ScheduleConflict = z.infer<typeof ScheduleConflict>;

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
  source: z.enum(["auto", "manual"]).default("auto"),
  /** Optimistic token (v3/11 gap 10) — see PatchFixture.expected_seq. */
  expected_seq: z.number().int().nonnegative().optional(),
});
export type ApplyScheduleRequest = z.infer<typeof ApplyScheduleRequest>;

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
  answers: z.record(z.string(), z.unknown()).default({}),
  // Team registrations may include a squad roster (typed or imported). Ignored
  // for individual/pair entrants.
  players: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        dob: z.iso.date().nullish(),
        squad_number: z.number().int().min(0).max(999).nullish(),
      }),
    )
    .max(50)
    .default([]),
  /** Honeypot (v3/05 §4): hidden on the real form; bots that fill it get a
   *  generic rejection in the route before any work happens. */
  website: z.string().max(200).optional(),
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
  created_at: z.string(),
});

export const CreateClub = z.object({
  name: z.string().min(1).max(200),
  short_name: z.string().min(1).max(40).optional(),
  colors: z.record(z.string(), z.string()).optional(),
  external_ref: z.string().min(1).max(100).optional(),
});
export type CreateClub = z.infer<typeof CreateClub>;

export const PatchClub = z.object({
  name: z.string().min(1).max(200).optional(),
  short_name: z.string().min(1).max(40).nullable().optional(),
  colors: z.record(z.string(), z.string()).nullable().optional(),
  external_ref: z.string().min(1).max(100).nullable().optional(),
  logo_path: z.string().nullable().optional(),
});
export type PatchClub = z.infer<typeof PatchClub>;

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
  role_keys: z.array(z.string()),
  home_pool_id: z.string().nullable(),
  max_per_day: z.number().int().nullable(),
  created_at: z.string(),
});

export const CreateOfficial = z.object({
  display_name: z.string().min(1).max(200),
  person_id: Uuid.optional(),
  entrant_id: Uuid.optional(),
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

export const CreateCheckpoint = z.object({ label: z.string().min(1).max(120) });

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

export const AiConstraintsRequest = z.object({ prose: z.string().min(3).max(4000) });

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
