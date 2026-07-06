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
    description: z.string().max(5000).nullable(),
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
    /** Pin/lock (doc 12 §2): locked assignments survive re-running auto. */
    schedule_locked: z.boolean(),
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
  "pending", "paid", "confirmed", "waitlisted", "withdrawn",
]);

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
    currency: z.string().length(3).toLowerCase().default("usd"),
    refund_lock_at: z.iso.datetime({ offset: true }).nullish(),
    form_fields: z.array(RegistrationFormField).max(12).default([]),
  })
  .superRefine((s, ctx) => {
    const keys = s.form_fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", message: "duplicate form field keys" });
    }
  });
export type PutRegistrationSettings = z.infer<typeof PutRegistrationSettings>;

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
  /** Paid registration readiness (org-level): Stripe Connect charges enabled. */
  charges_enabled: z.boolean(),
  updated_at: z.string().nullable(),
});

/** Organiser view of one registration. dob/contact stay org-side only. */
export const Registration = z.object({
  id: Uuid,
  division_id: Uuid,
  status: RegistrationStatus,
  display_name: z.string(),
  contact_email: z.string(),
  dob: z.string().nullable(),
  gender: z.string().nullable(),
  guardian_name: z.string().nullable(),
  guardian_consent: z.boolean(),
  answers: z.record(z.string(), z.unknown()),
  amount_cents: z.number().int(),
  currency: z.string().nullable(),
  payment_intent_id: z.string().nullable(),
  refunded_cents: z.number().int(),
  refunded_at: z.string().nullable(),
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
  opens_at: z.string().nullable(),
  closes_at: z.string().nullable(),
  capacity: z.number().int().nullable(),
  /** Spots left before new submissions waitlist; null = uncapped. */
  remaining: z.number().int().nullable(),
  open: z.boolean(),
  /** 'window' | 'full' (waitlist only) | 'payments_unavailable' | null */
  closed_reason: z.string().nullable(),
  requires_dob: z.boolean(),
  form_fields: z.array(RegistrationFormField),
});

export const PublicRegistrationInfo = z.object({
  competition: z.object({ id: Uuid, name: z.string(), slug: z.string() }),
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
  answers: z.record(z.string(), z.unknown()).default({}),
});
export type PublicRegisterRequest = z.infer<typeof PublicRegisterRequest>;

export const PublicRegisterResponse = z.object({
  registration_id: Uuid,
  status: RegistrationStatus,
  /** Self-service secret, shown exactly once (status page / withdraw / pay). */
  access_token: z.string(),
  /** Stripe Checkout URL when an entry fee is due now. */
  checkout_url: z.string().nullable(),
});

/** Registrant-facing status view (token-gated; no dob, no payment ids). */
export const PublicRegistrationStatus = z.object({
  id: Uuid,
  status: RegistrationStatus,
  display_name: z.string(),
  division_name: z.string(),
  competition_name: z.string(),
  competition_slug: z.string(),
  org_slug: z.string(),
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
});
export type CreateConnectOnboarding = z.infer<typeof CreateConnectOnboarding>;

export const ConnectOnboardingLink = z.object({ url: z.string() });
