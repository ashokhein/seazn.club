import { z } from "zod";

/** Optional season/series container such as Summer2026 or Local001. */
export const seasonSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  created_at: z.string(),
});
export type Season = z.infer<typeof seasonSchema>;

/** Authenticated user. `password_hash` is never sent to the client. */
export const userSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  email: z.string(),
  avatar_url: z.string().nullable(),
});
export type User = z.infer<typeof userSchema>;

// ---- organizations / teams ---------------------------------------------------

/** Access levels within an organization, from most to least privileged. */
export const ORG_ROLES = ["owner", "admin", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Roles allowed to edit (create tournaments, record results, manage members). */
export const EDITOR_ROLES = ["owner", "admin"] as const;

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_by: string | null;
  created_at: string;
  logo_url: string | null;
  logo_storage_path: string | null;
}

/** An organization paired with the current user's role in it. */
export interface OrgMembership extends Organization {
  role: OrgRole;
}

/** A member row joined with the user's identity, for the members panel. */
export interface OrgMember {
  user_id: string;
  email: string;
  display_name: string;
  avatar_url: string | null;
  role: OrgRole;
  created_at: string;
}

export interface OrgInvite {
  id: string;
  org_id: string;
  role: OrgRole;
  token: string;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  revoked: boolean;
  created_at: string;
}

/** Preview shown on the public /join/<token> page before joining. */
export interface InvitePreview {
  org_name: string;
  role: OrgRole;
  valid: boolean;
  reason?: string;
}

export const TOURNAMENT_FORMATS = [
  "swiss_knockout",
  "progress_stepladder",
  "knockout",
  "round_robin",
] as const;
export const TOURNAMENT_CATEGORIES = ["open", "adult", "kids"] as const;
export const TOURNAMENT_STATUSES = [
  "setup",
  "group",
  "knockout",
  "final",
  "completed",
] as const;
export const RESULT_MODES = ["win_loss", "score"] as const;

export type TournamentFormat = (typeof TOURNAMENT_FORMATS)[number];
export type TournamentCategory = (typeof TOURNAMENT_CATEGORIES)[number];
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];
export type ResultMode = (typeof RESULT_MODES)[number];

/** Org-level default settings for a sport — used when creating tournaments. */
export interface SportPreset {
  id: string;
  org_id: string;
  sport_key: string;
  sport_name: string;
  entity_label: string;
  format: TournamentFormat;
  result_mode: ResultMode;
  score_label: string;
  points_win: number;
  points_draw: number;
  points_loss: number;
  allow_draws: boolean;
  use_progress_score: boolean;
  round_minutes: number;
  clock_minutes: number;
  default_category: TournamentCategory;
  default_group_rounds: number | null;
  default_knockout_size: number | null;
  is_system: boolean;
  sort_order: number;
  created_at: string;
}

export interface Tournament {
  id: string;
  org_id: string;
  season_id: string | null;
  created_by: string | null;
  sport: string;
  name: string;
  category: TournamentCategory;
  format: TournamentFormat;
  num_group_rounds: number;
  knockout_size: number;
  status: TournamentStatus;
  undo_remaining: number;
  result_mode: ResultMode;
  score_label: string;
  points_win: number;
  points_draw: number;
  points_loss: number;
  allow_draws: boolean;
  use_progress_score: boolean;
  starts_at: string | null;
  round_minutes: number;
  clock_minutes: number;
  is_public: boolean;
  public_slug: string | null;
  state_version: number;
  venue: string | null;
  created_at: string;
}

export interface Player {
  id: string;
  tournament_id: string;
  name: string;
  seed: number;
  checked_in: boolean;
  image_url: string | null;
  image_storage_path: string | null;
}

export type RoundStage = "group" | "playoff" | "knockout" | "final";
export type RoundStatus = "pending" | "active" | "completed";

export interface Round {
  id: string;
  tournament_id: string;
  round_number: number;
  stage: RoundStage;
  name: string;
  status: RoundStatus;
}

export type MatchStatus = "pending" | "ready" | "completed";

export interface Match {
  id: string;
  tournament_id: string;
  round_id: string;
  board_number: number;
  player1_id: string | null;
  player2_id: string | null;
  winner_id: string | null;
  loser_id: string | null;
  player1_score: number | null;
  player2_score: number | null;
  is_draw: boolean;
  next_match_id: string | null;
  next_slot: number | null;
  is_bye: boolean;
  status: MatchStatus;
  label: string | null;
}

/** Full snapshot returned by the state API and rendered by the live view. */
export interface TournamentState {
  tournament: Tournament;
  players: Player[];
  rounds: Round[];
  matches: Match[];
  standings: StandingRow[];
}

/** One row of the activity / audit history. */
export const AUDIT_ACTIONS = [
  "create",
  "start",
  "record_result",
  "undo",
  "reset",
  "checkin",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEntry {
  id: string;
  tournament_id: string | null;
  actor: string | null;
  action: string;
  summary: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

/** Per-player computed standings row. */
export interface StandingRow {
  player: Player;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  progressScore: number;
  buchholz: number;
  scoreFor: number;
  scoreAgainst: number;
  scoreDiff: number;
  rank: number;
}

// ---- request payload schemas -------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(6).max(100),
}).strict();

export const signupSchema = loginSchema;

// ---- organization request payloads -------------------------------------------

// The slug is generated automatically; only a display name is collected.
export const createOrgSchema = z.object({
  name: z.string().min(1).max(60),
}).strict();

export const renameOrgSchema = z.object({
  name: z.string().min(1).max(60),
}).strict();

export const createInviteSchema = z.object({
  role: z.enum(["admin", "viewer"]),
  max_uses: z.number().int().min(0).max(1000).default(1),
  expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
}).strict();

export const setRoleSchema = z.object({
  role: z.enum(ORG_ROLES),
}).strict();

export const setActiveOrgSchema = z.object({
  org_id: z.string().uuid(),
}).strict();

const sportPresetFieldsSchema = z.object({
  sport_name: z.string().min(1).max(40),
  entity_label: z.enum(["Players", "Teams"]),
  format: z.enum(TOURNAMENT_FORMATS),
  result_mode: z.enum(RESULT_MODES),
  score_label: z.string().min(1).max(20),
  points_win: z.number().int().min(0).max(100),
  points_draw: z.number().int().min(0).max(100),
  points_loss: z.number().int().min(0).max(100),
  allow_draws: z.boolean(),
  use_progress_score: z.boolean(),
  round_minutes: z.number().int().min(1).max(600),
  clock_minutes: z.number().int().min(0).max(600),
  default_category: z.enum(TOURNAMENT_CATEGORIES),
  default_group_rounds: z.number().int().min(0).max(20).nullable(),
  default_knockout_size: z
    .number()
    .int()
    .refine((n) => [0, 2, 4, 8, 16].includes(n))
    .nullable(),
}).strict();

export const createSportPresetSchema = sportPresetFieldsSchema;

export const updateSportPresetSchema = sportPresetFieldsSchema.partial();

/**
 * A participant on the create form. Accepts either a bare name string or an
 * object with an optional image (logo / flag / photo) as a URL or data URI.
 */
export const playerInputSchema = z.union([
  z.string().min(1).max(60),
  z.object({
    name: z.string().min(1).max(60),
    image_url: z.string().max(1_500_000).nullable().optional(),
  }).strict(),
]);
export type PlayerInput = z.infer<typeof playerInputSchema>;

export const createTournamentSchema = z.object({
  season_id: z.string().uuid().nullable().optional(),
  sport: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  category: z.enum(TOURNAMENT_CATEGORIES),
  format: z.enum(TOURNAMENT_FORMATS),
  num_group_rounds: z.number().int().min(0).max(20),
  knockout_size: z.number().int().min(0).max(64),
  players: z.array(playerInputSchema).min(2).max(128),
  result_mode: z.enum(RESULT_MODES).default("win_loss"),
  score_label: z.string().max(20).default("Score"),
  points_win: z.number().int().min(0).max(100).default(1),
  points_draw: z.number().int().min(0).max(100).default(0),
  points_loss: z.number().int().min(0).max(100).default(0),
  allow_draws: z.boolean().default(false),
  use_progress_score: z.boolean().default(false),
  starts_at: z.string().nullable().optional(),
  round_minutes: z.number().int().min(1).max(600).default(30),
  clock_minutes: z.number().int().min(0).max(600).default(0),
  venue: z.string().max(120).nullable().optional(),
}).strict();

export const createSeasonSchema = z.object({
  name: z.string().min(1).max(60),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Use lowercase letters, numbers and dashes only"),
}).strict();

/** Record a match result: either a winner (win_loss) or scores (score mode). */
export const recordResultSchema = z
  .object({
    match_id: z.string().uuid(),
    winner_id: z.string().uuid().nullable().optional(),
    player1_score: z.number().int().min(0).max(100000).nullable().optional(),
    player2_score: z.number().int().min(0).max(100000).nullable().optional(),
    is_draw: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.winner_id != null ||
      v.is_draw === true ||
      (v.player1_score != null && v.player2_score != null),
    { message: "Provide a winner, a draw, or both scores" },
  );

export const setCheckInSchema = z.object({
  player_id: z.string().uuid(),
  checked_in: z.boolean(),
}).strict();

/** Add entrants to a tournament that has not started yet. */
export const addPlayersSchema = z.object({
  players: z.array(playerInputSchema).min(1).max(32),
}).strict();

// ---- account lifecycle schemas -----------------------------------------------

export const transferOwnerSchema = z.object({
  new_owner_id: z.string().uuid(),
}).strict();

export const changeEmailSchema = z.object({
  new_email: z.string().email().max(120),
}).strict();

export const deleteAccountSchema = z.object({
  confirm: z.literal("DELETE"),
}).strict();

// ---- billing request schemas -------------------------------------------------

export const checkoutSchema = z.object({
  plan_key: z.enum(["pro"]),
  interval: z.enum(["monthly", "annual"]),
}).strict();

// ---- billing types -----------------------------------------------------------

export const PLAN_KEYS = ["community", "pro"] as const;
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "suspended",
] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface Plan {
  key: PlanKey;
  name: string;
  stripe_price_id_monthly: string | null;
  stripe_price_id_annual: string | null;
  is_public: boolean;
  created_at: string;
}

export interface Subscription {
  org_id: string;
  plan_key: PlanKey;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}
