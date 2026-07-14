import { z } from "zod";
import { isValidIana } from "@/lib/tz";

/** Authenticated user. `password_hash` is never sent to the client. */
export const userSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string(),
  email: z.string(),
  avatar_url: z.string().nullable(),
  /** IANA zone (spec 2026-07-14); null = follow the browser (seazn_tz cookie). */
  timezone: z.string().nullable(),
});
export type User = z.infer<typeof userSchema>;

// ---- organizations / teams ---------------------------------------------------

/** Access levels within an organization, from most to least privileged.
 *  `scorer` (doc 13) is scoring-only: no org-wide read, assigned scope only. */
export const ORG_ROLES = ["owner", "admin", "viewer", "scorer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Roles allowed to edit (create tournaments, record results, manage members). */
export const EDITOR_ROLES = ["owner", "admin"] as const;

/** Roles with org-wide read access (doc 13 §2 — scorers see assigned scope only). */
export const READ_ROLES = ["owner", "admin", "viewer"] as const;

/** Scorer assignment scopes (doc 13 §3): fixture ⊂ division ⊂ competition. */
export const SCORER_SCOPE_TYPES = ["competition", "division", "fixture"] as const;
export type ScorerScopeType = (typeof SCORER_SCOPE_TYPES)[number];

export interface Organization {
  id: string;
  name: string;
  slug: string;
  created_by: string | null;
  created_at: string;
  logo_url: string | null;
  logo_storage_path: string | null;
  payment_instructions: string | null;
  /** Preselect for NEW division registration settings (spec 2026-07-12 §3). */
  default_payment_method: "offline" | "stripe";
  /** `{ colors: { primary: "#hex" } }` — same shape as competitions.branding. */
  branding: unknown;
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
  default_scope: { type: ScorerScopeType; id: string } | null;
  /** Invite-by-email: the recipient address; null for shareable links. */
  email: string | null;
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

// ---- request payload schemas -------------------------------------------------

export const loginSchema = z.object({
  email: z.string().email().max(120),
  password: z.string().min(6).max(100),
  /** Post-auth redirect carried through invite links; validated server-side
   *  by safeNextPath. Without this key .strict() 400s every invite signup. */
  next: z.string().max(500).optional(),
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

export const updateProfileSchema = z.object({
  display_name: z.string().trim().min(1).max(80).optional(),
  /** IANA zone or null to clear ("follow my browser"). Rejects bogus zones so
   *  the column only ever holds a value the render layer's Intl accepts. */
  timezone: z
    .string()
    .trim()
    .refine((v) => isValidIana(v), { message: "Unknown timezone" })
    .nullable()
    .optional(),
}).strict().refine((v) => v.display_name !== undefined || v.timezone !== undefined, {
  message: "Nothing to update",
});

export const createInviteSchema = z.object({
  role: z.enum(["admin", "viewer", "scorer"]),
  max_uses: z.number().int().min(0).max(1000).default(1),
  /** Invite-by-email: send the join link to this address (forces single-use). */
  email: z.string().trim().email().max(120).nullable().optional(),
  expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
  /** Scorer invites only (doc 13 §4): accept creates this assignment too. */
  default_scope: z
    .object({ type: z.enum(SCORER_SCOPE_TYPES), id: z.string().uuid() })
    .nullable()
    .optional(),
}).strict();

export const setRoleSchema = z.object({
  role: z.enum(ORG_ROLES),
}).strict();

export const setActiveOrgSchema = z.object({
  org_id: z.string().uuid(),
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
  /** One trial per org (V277): stamped when the first trial starts, never cleared. */
  trial_used_at: string | null;
  cancel_at_period_end: boolean;
  updated_at: string;
}
