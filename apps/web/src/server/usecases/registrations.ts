import "server-only";
// Online registration & entry fees (doc 16 §1.1, PROMPT-20a).
//
// Lifecycle: public submit → pending (holds a spot) | waitlisted (over
// capacity) → paid (Stripe checkout completed) → confirmed (entrant
// materialised, entrant_id set EXACTLY once — idempotent) → withdrawn
// (frees the spot; oldest waitlisted auto-promotes; auto-refund before
// refund_lock_at, organiser-discretion after — all audited on the
// competition_events ledger).
//
// Public paths (submit / status / withdraw / pay) run on the superuser
// connection like the public read models — registrants have no org session;
// the access token (sha256 stored, shown once) is their credential.
// Organiser paths ride withTenant/RLS as usual.
import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";
import type Stripe from "stripe";
import { sql, withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { getLimit, requireFeature } from "@/lib/entitlements";
import { platformFeeDefault } from "@/lib/platform-settings";
import { getStripe } from "@/lib/stripe";
import { captureServer } from "@/lib/posthog-server";
import { EVENTS } from "@/lib/analytics-events";
import {
  sendRegistrationEmail,
  sendPaymentReminderEmail,
  sendRegistrationPromotedEmail,
  sendRefundIssuedEmail,
  sendDisputeAlertEmail,
} from "@/lib/email";
import { generateRefCode, isValidRefCode, normalizeRefCode } from "@/lib/ref-code";
import { maskDisplayName, resolveNameDisplay } from "@/lib/name-display";
import type { AuthCtx } from "@/server/api-v1/auth";
import type {
  PublicRegisterRequest,
  PutRegistrationSettings,
  RegistrationFormField,
} from "@/server/api-v1/schemas";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { resolveLogoUrl } from "@/server/public-site/data";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";

type Tx = postgres.TransactionSql;

// ---------------------------------------------------------------------------
// Pure helpers — fee math & eligibility (unit-tested directly)
// ---------------------------------------------------------------------------

export const REGISTRATION_TOKEN_PREFIX = "rg_";

/** The platform cut for THIS org + competition (v3/07 §2 fee row): per-org
 *  override → `registration.fee_percent` entitlement (pro 2, event-pass 5) →
 *  the admin-set platform default (spec §1). */
export async function feePercentFor(orgId: string, competitionId?: string): Promise<number> {
  const pct = await getLimit(orgId, "registration.fee_percent", competitionId);
  return pct == null || pct <= 0 ? platformFeeDefault() : pct;
}

/** application_fee_amount for a destination charge. Never exceeds the fee. */
export function applicationFeeCents(feeCents: number, percent: number): number {
  return Math.min(feeCents, Math.round((feeCents * percent) / 100));
}

export function hashRegistrationToken(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function mintRegistrationToken(): string {
  return REGISTRATION_TOKEN_PREFIX + randomBytes(24).toString("base64url");
}

/** Whole years between dob and `at` (doc 06 §2.1: never approximate). */
export function ageAt(dobIso: string, at: Date): number {
  const dob = new Date(`${dobIso}T00:00:00Z`);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    at.getUTCMonth() < dob.getUTCMonth() ||
    (at.getUTCMonth() === dob.getUTCMonth() && at.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Guardian consent threshold (doc 06 §4.7 / doc 16 §1.1): under 18 today. */
export function isMinor(dobIso: string, now: Date): boolean {
  return ageAt(dobIso, now) < 18;
}

interface AgeRule {
  kind: "age";
  maxAgeAt?: number;
  minAgeAt?: number;
  cutoff?: { month: number; day: number; yearOf?: "season_start" | "calendar" };
}
interface GenderRule {
  kind: "gender";
  allowed: string[];
}

/** Division has an age rule ⇒ the form must collect DOB. */
export function requiresDob(rules: unknown[]): boolean {
  return rules.some((r) => (r as { kind?: string })?.kind === "age");
}

/**
 * Validate a registrant against the division's eligibility rules (doc 06 §2).
 * Only 'age' and 'gender' are checkable at registration; roster/grade/custom
 * rules are organiser-side. Returns human issues; empty = eligible.
 * `seasonStartYear` anchors cutoff.yearOf='season_start' (doc 06 §2.1).
 */
export function eligibilityIssues(
  rules: unknown[],
  input: { dob?: string | null; gender?: string | null },
  seasonStartYear: number,
): string[] {
  const issues: string[] = [];
  for (const raw of rules) {
    const rule = raw as { kind?: string };
    if (rule.kind === "age") {
      const r = raw as AgeRule;
      if (!input.dob) {
        issues.push("Date of birth is required for this age-restricted division.");
        continue;
      }
      const cutoff = r.cutoff ?? { month: 1, day: 1, yearOf: "calendar" as const };
      const year =
        cutoff.yearOf === "season_start" ? seasonStartYear : new Date().getUTCFullYear();
      const cutoffDate = new Date(Date.UTC(year, (cutoff.month ?? 1) - 1, cutoff.day ?? 1));
      const age = ageAt(input.dob, cutoffDate);
      if (r.maxAgeAt !== undefined && age > r.maxAgeAt) {
        issues.push(`Too old for this division (must be ${r.maxAgeAt} or younger on the cutoff date).`);
      }
      if (r.minAgeAt !== undefined && age < r.minAgeAt) {
        issues.push(`Too young for this division (must be ${r.minAgeAt} or older on the cutoff date).`);
      }
    } else if (rule.kind === "gender") {
      const r = raw as GenderRule;
      if (!input.gender) {
        issues.push("Gender is required for this division.");
      } else if (!r.allowed.includes(input.gender)) {
        issues.push("This division is not open to your gender category.");
      }
    }
  }
  return issues;
}

/** Validate answers against the bounded form definition; returns the kept
 *  subset (unknown keys dropped — the form is the contract). */
export function validateAnswers(
  fields: RegistrationFormField[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const f of fields) {
    const v = answers[f.key];
    const empty = v === undefined || v === null || v === "";
    if (f.required && (empty || v === false)) {
      throw new HttpError(422, `"${f.label}" is required`);
    }
    if (empty) continue;
    if (f.kind === "checkbox") {
      if (typeof v !== "boolean") throw new HttpError(422, `"${f.label}" must be true/false`);
      kept[f.key] = v;
    } else if (f.kind === "select") {
      if (typeof v !== "string" || !(f.options ?? []).includes(v)) {
        throw new HttpError(422, `"${f.label}" must be one of the offered options`);
      }
      kept[f.key] = v;
    } else {
      if (typeof v !== "string" || v.length > 1000) {
        throw new HttpError(422, `"${f.label}" must be text (max 1000 chars)`);
      }
      kept[f.key] = v;
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Rows & shared internals
// ---------------------------------------------------------------------------

export interface RegistrationSettingsRow {
  division_id: string;
  enabled: boolean;
  entrant_kind: "team" | "individual" | "pair";
  opens_at: Date | null;
  closes_at: Date | null;
  capacity: number | null;
  fee_cents: number;
  currency: string;
  refund_lock_at: Date | null;
  form_fields: RegistrationFormField[];
  payment_method: "offline" | "stripe";
  /** Per-division override; null → org.payment_instructions. */
  payment_instructions: string | null;
  updated_at: Date | null;
}

export interface RegistrationRow {
  id: string;
  division_id: string;
  org_id: string;
  status: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" | "expired";
  /** Human-quotable reference (v3/05 §3); null on pre-v2 rows. */
  ref_code: string | null;
  display_name: string;
  contact_email: string;
  dob: string | null;
  gender: string | null;
  guardian_name: string | null;
  guardian_consent: boolean;
  answers: Record<string, unknown>;
  roster: { name: string; dob?: string | null; squad_number?: number | null }[];
  amount_cents: number;
  currency: string | null;
  payment_method: "offline" | "stripe" | null;
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  refunded_cents: number;
  refunded_at: Date | null;
  /** Card pendings only: pay-by deadline (spec §2, 48h). */
  expires_at: Date | null;
  reminded_at: Date | null;
  offline_marked_paid_at: Date | null;
  disputed_at: Date | null;
  dispute_id: string | null;
  entrant_id: string | null;
  promoted_at: Date | null;
  withdrawn_at: Date | null;
  created_at: Date;
}

const REG_COLS = [
  "id", "division_id", "org_id", "status", "ref_code", "display_name",
  "contact_email", "dob", "gender", "guardian_name", "guardian_consent",
  "answers", "roster", "amount_cents", "currency", "payment_method",
  "checkout_session_id", "payment_intent_id", "refunded_cents", "refunded_at",
  "expires_at", "reminded_at", "offline_marked_paid_at", "disputed_at",
  "dispute_id", "entrant_id", "promoted_at", "withdrawn_at", "created_at",
] as const;

const SETTINGS_COLS = [
  "division_id", "enabled", "entrant_kind", "opens_at", "closes_at",
  "capacity", "fee_cents", "currency", "refund_lock_at", "form_fields",
  "payment_method", "payment_instructions", "updated_at",
] as const;

/** Statuses that hold a capacity spot. */
const SPOT_HOLDERS = ["pending", "paid", "confirmed"] as const;

// Both the superuser client and a withTenant tx serve the shared helpers
// (TransactionSql omits connection controls, so it isn't a plain Sql).
type AnySql = Tx | postgres.Sql;

async function loadSettings(db: AnySql, divisionId: string): Promise<RegistrationSettingsRow | null> {
  const [row] = await db<RegistrationSettingsRow[]>`
    select ${sql(SETTINGS_COLS as unknown as string[])} from registration_settings
    where division_id = ${divisionId}`;
  return row ?? null;
}

async function activeCount(db: AnySql, divisionId: string): Promise<number> {
  const [{ n }] = await db<{ n: number }[]>`
    select count(*)::int as n from registrations
    where division_id = ${divisionId} and status in ${sql([...SPOT_HOLDERS])}`;
  return n;
}

/** Append to the competition_events audit ledger (016 pattern). */
async function audit(
  db: AnySql,
  competitionId: string,
  orgId: string,
  type: string,
  payload: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  await db`
    insert into competition_events (competition_id, org_id, type, payload, actor_id)
    values (${competitionId}, ${orgId}, ${type}, ${sql.json(payload as never)}, ${actorId})`;
}

interface DivisionCtx {
  id: string;
  competition_id: string;
  org_id: string;
  eligibility: unknown[];
  comp_name: string;
  comp_slug: string;
  comp_visibility: string;
  starts_on: string | null;
  ends_on: string | null;
  org_slug: string;
  org_name: string;
  payment_instructions: string | null;
  charges_enabled: boolean;
}

async function divisionCtx(db: AnySql, divisionId: string): Promise<DivisionCtx> {
  const [row] = await db<DivisionCtx[]>`
    select d.id, d.competition_id, d.org_id, d.eligibility,
           c.name as comp_name, c.slug as comp_slug, c.visibility as comp_visibility,
           c.starts_on, c.ends_on,
           o.slug as org_slug, o.name as org_name, o.payment_instructions,
           o.stripe_charges_enabled as charges_enabled
    from divisions d
    join competitions c on c.id = d.competition_id
    join organizations o on o.id = c.org_id
    where d.id = ${divisionId}`;
  if (!row) throw new HttpError(404, "division not found");
  return row;
}

function seasonStartYear(ctx: DivisionCtx): number {
  return ctx.starts_on
    ? new Date(`${ctx.starts_on}T00:00:00Z`).getUTCFullYear()
    : new Date().getUTCFullYear();
}

/** Origin for emails fired from request-less paths (withdraw promotions):
 *  same override order as lib/base-url, localhost as the dev fallback. */
function fallbackOrigin(): string {
  return (
    process.env.OAUTH_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function windowOpen(s: RegistrationSettingsRow, now: Date): boolean {
  if (!s.enabled) return false;
  if (s.opens_at && now < new Date(s.opens_at)) return false;
  if (s.closes_at && now > new Date(s.closes_at)) return false;
  return true;
}

/**
 * Materialise a confirmed registration into an entrant (doc 16 §1.1:
 * "Registration → entrant on confirm"). Idempotent: entrant_id is set exactly
 * once under a row lock; a second call is a no-op. Individuals also get a
 * person (dob/gender feed eligibility; consent defaults empty = initials on
 * public surfaces, doc 06 §4.7).
 */
async function materialise(tx: Tx, reg: RegistrationRow, entrantKind: string): Promise<string> {
  if (reg.entrant_id) return reg.entrant_id;
  const [entrant] = await tx<{ id: string }[]>`
    insert into entrants (division_id, kind, display_name, status)
    values (${reg.division_id}, ${entrantKind}, ${reg.display_name}, 'confirmed')
    returning id`;
  if (entrantKind === "individual") {
    const [person] = await tx<{ id: string }[]>`
      insert into persons (org_id, full_name, dob, gender)
      values (${reg.org_id}, ${reg.display_name}, ${reg.dob}, ${reg.gender})
      returning id`;
    await tx`
      insert into entrant_members (entrant_id, person_id)
      values (${entrant.id}, ${person.id})`;
  } else if (entrantKind === "team" && reg.roster.length > 0) {
    // Team roster supplied at registration → a person + squad member per player.
    for (const p of reg.roster) {
      const name = p.name.trim();
      if (!name) continue;
      const [person] = await tx<{ id: string }[]>`
        insert into persons (org_id, full_name, dob)
        values (${reg.org_id}, ${name}, ${p.dob ?? null})
        returning id`;
      await tx`
        insert into entrant_members (entrant_id, person_id, squad_number)
        values (${entrant.id}, ${person.id}, ${p.squad_number ?? null})
        on conflict (entrant_id, person_id) do nothing`;
    }
  }
  await tx`
    update registrations
    set entrant_id = ${entrant.id}, status = 'confirmed', expires_at = null,
        updated_at = now()
    where id = ${reg.id}`;
  return entrant.id;
}

/** Oldest waitlisted → pending (doc 16 §1.1 auto-promotion). Waitlisted rows
 *  hold amount 0, so promotion SNAPSHOTS the current fee + method (spec §2);
 *  card divisions get a fresh 48h pay window. Returns the promoted row. */
async function promoteOldestWaitlisted(
  tx: Tx,
  divisionId: string,
  settings: RegistrationSettingsRow | null,
): Promise<RegistrationRow | null> {
  const feeCents = settings?.fee_cents ?? 0;
  const method = settings?.payment_method ?? "offline";
  const stripeWindow = method === "stripe" && feeCents > 0;
  const [row] = await tx<RegistrationRow[]>`
    update registrations
    set status = 'pending', promoted_at = now(), updated_at = now(),
        amount_cents = ${feeCents},
        currency = ${settings?.currency ?? "gbp"},
        payment_method = ${method},
        expires_at = ${stripeWindow ? tx`now() + interval '48 hours'` : null}
    where id = (
      select id from registrations
      where division_id = ${divisionId} and status = 'waitlisted'
      order by created_at, id limit 1
      for update skip locked)
    returning ${sql(REG_COLS as unknown as string[])}`;
  return row ?? null;
}

/** Post-tx promoted email (fire-and-forget): card entries get a fresh
 *  token-free checkout link, offline entries the resolved instructions. */
async function notifyPromoted(
  promoted: RegistrationRow,
  ctx: DivisionCtx,
  settings: RegistrationSettingsRow | null,
  origin: string,
): Promise<void> {
  try {
    let payUrl: string | null = null;
    if (promoted.payment_method === "stripe" && promoted.amount_cents > 0 && ctx.charges_enabled) {
      try {
        payUrl = await createRegistrationCheckout(promoted, ctx, origin, null);
      } catch {
        /* the reminder sweep mints another */
      }
    }
    await sendRegistrationPromotedEmail({
      to: promoted.contact_email,
      orgName: ctx.org_name,
      competitionName: ctx.comp_name,
      displayName: promoted.display_name,
      feeCents: promoted.amount_cents,
      currency: promoted.currency ?? settings?.currency ?? "gbp",
      payUrl,
      payDeadline: promoted.expires_at,
      paymentInstructions:
        promoted.payment_method === "offline" && promoted.amount_cents > 0
          ? (settings?.payment_instructions ?? ctx.payment_instructions)
          : null,
      refCode: promoted.ref_code,
      refStatusUrl: promoted.ref_code ? `${origin}/r/${promoted.ref_code}` : null,
    });
  } catch {
    /* fire-and-forget */
  }
}

// ---------------------------------------------------------------------------
// Organiser: settings
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS: Omit<RegistrationSettingsRow, "division_id"> = {
  enabled: false,
  entrant_kind: "individual",
  opens_at: null,
  closes_at: null,
  capacity: null,
  fee_cents: 0,
  currency: "gbp",
  refund_lock_at: null,
  form_fields: [],
  payment_method: "offline",
  payment_instructions: null,
  updated_at: null,
};

export interface OrgPaymentDefaults {
  charges_enabled: boolean;
  org_payment_instructions: string | null;
  org_default_payment_method: string;
}

async function orgPaymentDefaults(orgId: string): Promise<OrgPaymentDefaults> {
  const [row] = await sql<OrgPaymentDefaults[]>`
    select stripe_charges_enabled as charges_enabled,
           payment_instructions as org_payment_instructions,
           default_payment_method as org_default_payment_method
    from organizations where id = ${orgId}`;
  if (!row) throw new HttpError(404, "organization not found");
  return row;
}

export async function getRegistrationSettings(
  auth: AuthCtx,
  divisionId: string,
): Promise<RegistrationSettingsRow & OrgPaymentDefaults> {
  const org = await orgPaymentDefaults(auth.orgId);
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const row = await loadSettings(tx, divisionId);
    return { division_id: divisionId, ...DEFAULT_SETTINGS, ...(row ?? {}), ...org };
  });
}

export async function putRegistrationSettings(
  auth: AuthCtx,
  divisionId: string,
  input: PutRegistrationSettings,
): Promise<RegistrationSettingsRow & OrgPaymentDefaults> {
  await requireFeature(auth.orgId, "registration.enabled");
  const [regDiv] = await sql<{ competition_id: string }[]>`
    select competition_id from divisions where id = ${divisionId}`;
  const org = await orgPaymentDefaults(auth.orgId);

  // Offline (cash/bank) fees are free on every plan — they fill the funnel.
  // Card collection is the paid layer (doc 16 §1.1): it needs a live Connect
  // account AND the registration.paid entitlement, and the fee must clear
  // Stripe's minimum charge (spec issue #13).
  // Zod defaults apply on the route; direct callers (tests, scripts) may omit
  // defaulted fields, so normalise exactly like the schema does.
  const method = input.payment_method ?? "offline";
  const feeCents = input.fee_cents ?? 0;
  const currency = input.currency ?? "gbp";
  const entrantKind = input.entrant_kind ?? "individual";
  const formFields = input.form_fields ?? [];
  if (method === "stripe") {
    if (!org.charges_enabled) {
      throw new HttpError(
        422,
        "Connect Stripe under Settings → Payments before choosing card payments",
      );
    }
    await requireFeature(auth.orgId, "registration.paid", regDiv?.competition_id);
    if (feeCents > 0 && feeCents < 100) {
      throw new HttpError(422, "Card entry fees must be at least 1.00 (or 0 for free)");
    }
  }

  // Capacity can't promise more than the plan's entrant quota (doc 10 §1) —
  // confirm would hit the wall after money changed hands.
  if (input.capacity != null) {
    const limit = await getLimit(auth.orgId, "entrants.per_division.max", regDiv?.competition_id);
    if (limit !== null && input.capacity > limit) {
      throw new HttpError(
        422,
        `Capacity exceeds your plan's entrant limit (${limit}) — raise the plan or lower the capacity`,
      );
    }
  }
  if (input.opens_at && input.closes_at && new Date(input.opens_at) >= new Date(input.closes_at)) {
    throw new HttpError(422, "closes_at must be after opens_at");
  }

  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [row] = await tx<RegistrationSettingsRow[]>`
      insert into registration_settings
        (division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
         fee_cents, currency, refund_lock_at, form_fields,
         payment_method, payment_instructions, updated_at)
      values
        (${divisionId}, ${input.enabled}, ${entrantKind},
         ${input.opens_at ?? null}, ${input.closes_at ?? null},
         ${input.capacity ?? null}, ${feeCents}, ${currency},
         ${input.refund_lock_at ?? null}, ${tx.json(formFields as never)},
         ${method}, ${input.payment_instructions?.trim() || null}, now())
      on conflict (division_id) do update set
        enabled              = excluded.enabled,
        entrant_kind         = excluded.entrant_kind,
        opens_at             = excluded.opens_at,
        closes_at            = excluded.closes_at,
        capacity             = excluded.capacity,
        fee_cents            = excluded.fee_cents,
        currency             = excluded.currency,
        refund_lock_at       = excluded.refund_lock_at,
        form_fields          = excluded.form_fields,
        payment_method       = excluded.payment_method,
        payment_instructions = excluded.payment_instructions,
        updated_at           = now()
      returning ${sql(SETTINGS_COLS as unknown as string[])}`;
    return { ...row, ...org };
  });
}

// ---------------------------------------------------------------------------
// Public: register panel info
// ---------------------------------------------------------------------------

export interface PublicDivisionInfo {
  division_id: string;
  name: string;
  slug: string;
  sport_key: string;
  entrant_kind: string;
  fee_cents: number;
  currency: string;
  /** How the entry fee is collected (spec §3). */
  payment_method: "offline" | "stripe";
  opens_at: string | null;
  closes_at: string | null;
  capacity: number | null;
  remaining: number | null;
  /** Spots already taken — drives the masthead capacity meter (v3/05 §2). */
  taken: number;
  open: boolean;
  /** 'window' | 'full' | 'payments_unavailable' | null */
  closed_reason: string | null;
  requires_dob: boolean;
  /** Youth division (v3/11 gap 8): the form always adds guardian consent. */
  youth: boolean;
  /** Queue length behind a full division (PROMPT-52) — public. */
  waitlisted: number;
  form_fields: RegistrationFormField[];
}

export interface PublicRegistrationInfoResult {
  competition: {
    id: string;
    name: string;
    slug: string;
    starts_on: string | null;
    ends_on: string | null;
  };
  org: { name: string; slug: string; logo_url: string | null };
  divisions: PublicDivisionInfo[];
}

/** The public register panel (superuser read; public/unlisted comps only). */
export async function publicRegistrationInfo(
  orgSlug: string,
  compSlug: string,
): Promise<PublicRegistrationInfoResult> {
  const [comp] = await sql<
    {
      id: string; name: string; slug: string; org_id: string; charges_enabled: boolean;
      starts_on: string | null; ends_on: string | null;
      org_name: string; logo_storage_path: string | null; logo_url: string | null;
    }[]
  >`
    select c.id, c.name, c.slug, c.org_id, o.stripe_charges_enabled as charges_enabled,
           c.starts_on, c.ends_on,
           o.name as org_name, o.logo_storage_path, o.logo_url
    from competitions c join organizations o on o.id = c.org_id
    where o.slug = ${orgSlug} and c.slug = ${compSlug}
      and c.visibility in ('public','unlisted') and o.status = 'active'`;
  if (!comp) throw new HttpError(404, "competition not found");

  const rows = await sql<
    (RegistrationSettingsRow & {
      name: string;
      slug: string;
      sport_key: string;
      eligibility: unknown[];
      youth: boolean;
      active: number;
      waitlisted: number;
    })[]
  >`
    select rs.*, d.name, d.slug, d.sport_key, d.eligibility, d.youth,
           (select count(*)::int from registrations r
             where r.division_id = rs.division_id
               and r.status in ${sql([...SPOT_HOLDERS])}) as active,
           (select count(*)::int from registrations r
             where r.division_id = rs.division_id
               and r.status = 'waitlisted') as waitlisted
    from registration_settings rs
    join divisions d on d.id = rs.division_id
    where d.competition_id = ${comp.id} and rs.enabled
    order by d.name`;

  const now = new Date();
  const divisions: PublicDivisionInfo[] = rows.map((r) => {
    const remaining =
      r.capacity === null ? null : Math.max(0, r.capacity - r.active);
    // A card division with Connect broken can't take submissions — closing it
    // with an honest reason beats accepting money we can't collect (spec #9).
    const paymentsBroken =
      r.payment_method === "stripe" && r.fee_cents > 0 && !comp.charges_enabled;
    const open = windowOpen(r, now) && !paymentsBroken;
    let reason: string | null = open ? null : paymentsBroken ? "payments_unavailable" : "window";
    if (open && remaining === 0) reason = "full"; // still open — joins the waitlist
    return {
      division_id: r.division_id,
      name: r.name,
      slug: r.slug,
      sport_key: r.sport_key,
      entrant_kind: r.entrant_kind,
      fee_cents: r.fee_cents,
      currency: r.currency,
      payment_method: r.payment_method,
      opens_at: r.opens_at ? new Date(r.opens_at).toISOString() : null,
      closes_at: r.closes_at ? new Date(r.closes_at).toISOString() : null,
      capacity: r.capacity,
      remaining,
      taken: r.active,
      open,
      closed_reason: reason,
      requires_dob: requiresDob(r.eligibility ?? []),
      youth: r.youth,
      waitlisted: r.waitlisted,
      form_fields: r.form_fields ?? [],
    };
  });
  return {
    competition: {
      id: comp.id,
      name: comp.name,
      slug: comp.slug,
      starts_on: comp.starts_on,
      ends_on: comp.ends_on,
    },
    org: {
      name: comp.org_name,
      slug: orgSlug,
      logo_url: resolveLogoUrl(comp.logo_storage_path, comp.logo_url),
    },
    divisions,
  };
}

// ---------------------------------------------------------------------------
// Public: submit
// ---------------------------------------------------------------------------

export interface SubmitResult {
  registration: RegistrationRow;
  access_token: string;
  checkout_url: string | null;
}

/**
 * Public registration submit (doc 16 §1.1). Free divisions → pending
 * (organiser approves); paid → pending + Stripe Checkout (payment confirms);
 * over capacity → waitlisted, no payment taken.
 */
export async function submitRegistration(
  orgSlug: string,
  compSlug: string,
  input: PublicRegisterRequest,
  origin: string,
): Promise<SubmitResult> {
  const ctx = await divisionCtx(sql, input.division_id);
  if (
    ctx.org_slug !== orgSlug ||
    ctx.comp_slug !== compSlug ||
    !["public", "unlisted"].includes(ctx.comp_visibility)
  ) {
    throw new HttpError(404, "division not found");
  }
  await requireFeature(ctx.org_id, "registration.enabled");

  const settings = await loadSettings(sql, input.division_id);
  if (!settings || !windowOpen(settings, new Date())) {
    throw new HttpError(422, "Registration is not open for this division");
  }

  // Eligibility (doc 06 §2): checkable rules validate now; the DOB the form
  // collected feeds the person row on confirm.
  const issues = eligibilityIssues(
    ctx.eligibility ?? [],
    { dob: input.dob, gender: input.gender },
    seasonStartYear(ctx),
  );
  if (issues.length > 0) throw new HttpError(422, issues.join(" "));

  // Guardian consent for minors (doc 06 §4.7, doc 16 §1.1).
  if (input.dob && isMinor(input.dob, new Date())) {
    if (!input.guardian_consent || !input.guardian_name?.trim()) {
      throw new HttpError(422, "A guardian's name and consent are required for players under 18");
    }
  }

  const answers = validateAnswers(settings.form_fields ?? [], input.answers);
  const secret = mintRegistrationToken();

  // Payment path is the division's choice (spec §3): offline entries are
  // accepted immediately with the organiser's instructions; card entries mint
  // a Stripe Checkout session at submit and hold the spot for 48 hours.
  const paid = settings.fee_cents > 0;
  const useStripe = paid && settings.payment_method === "stripe";
  if (useStripe && !ctx.charges_enabled) {
    throw new HttpError(
      503,
      "Card payments are temporarily unavailable for this event — try again shortly or contact the organiser",
    );
  }

  // postgres types begin() as UnwrapPromiseArray (db.ts note) — safe cast.
  const reg = (await sql.begin(async (tx) => {
      // Capacity under a settings row lock: two concurrent submits must not
      // both take the last spot.
      await tx`select 1 from registration_settings
               where division_id = ${input.division_id} for update`;
      const taken = await activeCount(tx, input.division_id);
      // The plan's entrant quota also bounds intake (doc 10 §1) — never
      // accept money for a spot the plan can't materialise.
      const planLimit = await getLimit(ctx.org_id, "entrants.per_division.max");
      const hardCap = Math.min(
        settings.capacity ?? Number.POSITIVE_INFINITY,
        planLimit ?? Number.POSITIVE_INFINITY,
      );
      const waitlisted = taken >= hardCap;
      // Roster only applies to team entries; drop it for individual/pair.
      const roster = settings.entrant_kind === "team" ? input.players : [];
      // Reference number (v3/05 §3): server-generated, unique per environment;
      // ~729M payload space so a couple of retries always clears a collision.
      let row: RegistrationRow | undefined;
      for (let attempt = 0; attempt < 5 && !row; attempt++) {
        const ref = generateRefCode();
        try {
          // Savepoint: a unique-violation must not abort the outer tx —
          // roll back to here and draw a fresh code instead.
          row = (await tx.savepoint(async (sp) => {
            const [r] = await sp<RegistrationRow[]>`
              insert into registrations
                (division_id, status, ref_code, display_name, contact_email, dob, gender,
                 guardian_name, guardian_consent, answers, roster, amount_cents, currency,
                 payment_method, expires_at, access_token_hash)
              values
                (${input.division_id}, ${waitlisted ? "waitlisted" : "pending"}, ${ref},
                 ${input.display_name}, ${input.contact_email}, ${input.dob ?? null},
                 ${input.gender ?? null}, ${input.guardian_name ?? null},
                 ${input.guardian_consent}, ${sp.json(answers as never)},
                 ${sp.json(roster as never)},
                 ${waitlisted ? 0 : settings.fee_cents}, ${settings.currency},
                 ${settings.payment_method},
                 ${useStripe && !waitlisted ? sp`now() + interval '48 hours'` : null},
                 ${hashRegistrationToken(secret)})
              returning ${sql(REG_COLS as unknown as string[])}`;
            return r;
          })) as unknown as RegistrationRow;
        } catch (err) {
          // 23505 on the ref index → draw again; anything else is real.
          const pg = err as { code?: string; constraint_name?: string };
          if (pg.code !== "23505" || !String(pg.constraint_name ?? "").includes("ref_code")) {
            throw err;
          }
        }
      }
      if (!row) throw new HttpError(503, "could not allocate a reference — please retry");
      await audit(tx, ctx.competition_id, ctx.org_id, "registration.submitted", {
        registration_id: row.id,
        division_id: input.division_id,
        status: row.status,
        fee_cents: row.amount_cents,
      }, null);
      return row;
    })) as unknown as RegistrationRow;

  // Card path: mint the Checkout session AFTER the tx (network call). A mint
  // failure must not lose the registration — the status page offers Pay and
  // the T-24h reminder carries a fresh link.
  let checkoutUrl: string | null = null;
  if (useStripe && reg.status === "pending") {
    try {
      checkoutUrl = await createRegistrationCheckout(reg, ctx, origin, secret);
    } catch {
      /* pay-later path stays available */
    }
  }

  // Confirmation email — offline entries carry the resolved cash/bank
  // instructions (division override → org); card entries carry the pay link
  // and deadline. Fire-and-forget: a mail hiccup must not fail the signup.
  const statusUrl =
    `${origin}/shared/${ctx.org_slug}/${ctx.comp_slug}/register/status` +
    `?rid=${reg.id}&token=${encodeURIComponent(secret)}`;
  const offlineInstructions = settings.payment_instructions ?? ctx.payment_instructions;
  void sendRegistrationEmail({
    to: reg.contact_email,
    orgName: ctx.org_name,
    competitionName: ctx.comp_name,
    displayName: reg.display_name,
    status: reg.status,
    feeCents: paid ? settings.fee_cents : 0,
    currency: settings.currency,
    paymentInstructions:
      paid && !useStripe && reg.status !== "waitlisted" ? offlineInstructions : null,
    payUrl: useStripe && reg.status === "pending" ? (checkoutUrl ?? statusUrl) : null,
    payDeadline: reg.expires_at,
    statusUrl,
    refCode: reg.ref_code,
    refStatusUrl: reg.ref_code ? `${origin}/r/${reg.ref_code}` : null,
  }).catch(() => {});

  // Public-registration funnel (feature 1): a distinct anonymous person per
  // registrant (no login here), grouped by the receiving org.
  await captureServer({
    event: EVENTS.REGISTRATION_SUBMITTED,
    distinctId: `reg:${reg.id}`,
    orgId: ctx.org_id,
    properties: {
      division_id: input.division_id,
      status: reg.status,
      paid,
      entrant_kind: settings.entrant_kind,
    },
  });

  return { registration: reg, access_token: secret, checkout_url: checkoutUrl };
}

/** Destination charge on the org's Connect account; the platform keeps
 *  application_fee_amount (doc 16 §1.1). Always charges the SNAPSHOTTED
 *  reg.amount_cents (spec issue #8), never live settings. `token` builds the
 *  status-page return URLs; null falls back to the token-free /r/[ref] pair
 *  (email-minted sessions — the reminder can't recover the hashed token). */
async function createRegistrationCheckout(
  reg: RegistrationRow,
  ctx: DivisionCtx,
  origin: string,
  token: string | null,
): Promise<string> {
  if (reg.amount_cents <= 0) throw new HttpError(422, "This registration has no entry fee");
  const [org] = await sql<{ stripe_account_id: string | null }[]>`
    select stripe_account_id from organizations where id = ${ctx.org_id}`;
  if (!org?.stripe_account_id) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const returnBase = token
    ? `${origin}/shared/${ctx.org_slug}/${ctx.comp_slug}/register/status` +
      `?rid=${reg.id}&token=${encodeURIComponent(token)}`
    : `${origin}/r/${reg.ref_code}?src=email`;
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: reg.contact_email,
    metadata: { kind: "registration", registration_id: reg.id, org_id: ctx.org_id },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: reg.currency ?? "gbp",
          unit_amount: reg.amount_cents,
          product_data: { name: `${ctx.comp_name} — entry fee (${reg.display_name})` },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: applicationFeeCents(
        reg.amount_cents,
        await feePercentFor(ctx.org_id, ctx.competition_id),
      ),
      transfer_data: { destination: org.stripe_account_id },
      metadata: { registration_id: reg.id, org_id: ctx.org_id },
    },
    success_url: `${returnBase}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${returnBase}&checkout=cancelled`,
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL");
  await sql`
    update registrations
    set checkout_session_id = ${session.id}, updated_at = now()
    where id = ${reg.id}`;
  return session.url;
}

// ---------------------------------------------------------------------------
// Payment completion (webhook + reconcile-on-return)
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed for a registration (webhook path — reuses the
 * billing_events idempotency shell in the stripe route). Marks paid, then
 * confirms + materialises in one tx. Safe to re-run: paid/confirmed short-
 * circuit, entrant_id is set once.
 */
export async function handleRegistrationCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const regId = session.metadata?.registration_id;
  if (!regId) return;
  const paymentIntent =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : (session.payment_intent?.id ?? null);
  await confirmPaidRegistration(regId, paymentIntent, session.amount_total ?? null);
}

type PayOutcome =
  | { kind: "confirmed"; divisionId: string; competitionId: string }
  | { kind: "late" | "duplicate"; reg: RegistrationRow; competitionId: string; intent: string }
  | null;

async function confirmPaidRegistration(
  regId: string,
  paymentIntentId: string | null,
  amountTotal: number | null,
): Promise<void> {
  const outcome = (await sql.begin(async (tx) => {
    const [reg] = await tx<RegistrationRow[]>`
      select ${sql(REG_COLS as unknown as string[])} from registrations
      where id = ${regId} for update`;
    if (!reg) return null;
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    // Already paid/confirmed: a replay of the SAME session is a no-op, but a
    // DIFFERENT intent means the registrant paid twice (two open checkout
    // tabs, spec issue #2) — refund the duplicate, keep the original.
    if (reg.status === "confirmed" || reg.status === "paid") {
      if (paymentIntentId && reg.payment_intent_id && paymentIntentId !== reg.payment_intent_id) {
        return { kind: "duplicate", reg, competitionId: div.competition_id, intent: paymentIntentId };
      }
      return null;
    }
    // Money landing on a dead registration (withdrawn/expired, spec issue #1):
    // record the intent for the audit trail and send it straight back.
    if (reg.status === "withdrawn" || reg.status === "expired") {
      await tx`update registrations
               set payment_intent_id = coalesce(payment_intent_id, ${paymentIntentId}),
                   updated_at = now()
               where id = ${regId}`;
      if (!paymentIntentId && !reg.payment_intent_id) return null;
      return {
        kind: "late",
        reg,
        competitionId: div.competition_id,
        intent: (reg.payment_intent_id ?? paymentIntentId) as string,
      };
    }
    const settings = await loadSettings(tx, reg.division_id);
    await tx`
      update registrations
      set status = 'paid',
          payment_intent_id = coalesce(${paymentIntentId}, payment_intent_id),
          amount_cents = coalesce(${amountTotal}, amount_cents),
          updated_at = now()
      where id = ${regId}`;
    const entrantId = await materialise(
      tx,
      { ...reg, status: "paid" },
      settings?.entrant_kind ?? "individual",
    );
    await audit(tx, div.competition_id, reg.org_id, "registration.confirmed", {
      registration_id: regId,
      entrant_id: entrantId,
      paid: true,
      amount_cents: amountTotal ?? reg.amount_cents,
    }, null);
    return { kind: "confirmed", divisionId: reg.division_id, competitionId: div.competition_id };
  })) as unknown as PayOutcome;

  if (!outcome) return;
  if (outcome.kind === "confirmed") {
    fireDivisionRevalidate(outcome.divisionId, outcome.competitionId);
    return;
  }
  // Refunds happen OUTSIDE the tx (network). A failure surfaces on the
  // organiser console via the audit trail, never blocks the webhook ACK.
  try {
    const refund = await stripeRefund(outcome.intent, undefined);
    if (outcome.kind === "late") {
      await sql`
        update registrations
        set refunded_cents = ${amountTotal ?? outcome.reg.amount_cents},
            refunded_at = now(), updated_at = now()
        where id = ${regId}`;
    }
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refunded", {
      registration_id: regId,
      amount_cents: amountTotal ?? outcome.reg.amount_cents,
      mode: outcome.kind === "late" ? "late_payment" : "duplicate",
      stripe_refund_id: refund.id,
    }, null);
    const ctxLate = await divisionCtx(sql, outcome.reg.division_id);
    notifyRefund(outcome.reg, ctxLate, amountTotal ?? outcome.reg.amount_cents);
  } catch {
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refund_failed", {
      registration_id: regId,
      mode: outcome.kind,
    }, null);
  }
}

/**
 * Dispute lifecycle (spec issue #5 — destination charges make the PLATFORM
 * liable): `created` flags the registration + alerts the org owner; `closed`
 * either clears the flag (won) or writes the money off (lost). No automatic
 * entrant changes — contested entries are the organiser's call.
 */
export async function handleRegistrationDispute(
  dispute: Stripe.Dispute,
  phase: "created" | "closed",
): Promise<void> {
  const intent =
    typeof dispute.payment_intent === "string"
      ? dispute.payment_intent
      : dispute.payment_intent?.id;
  if (!intent) return;
  const [reg] = await sql<RegistrationRow[]>`
    select ${sql(REG_COLS as unknown as string[])} from registrations
    where payment_intent_id = ${intent}`;
  if (!reg) return; // not an entry-fee charge
  const ctx = await divisionCtx(sql, reg.division_id);

  if (phase === "created") {
    await sql`update registrations
              set disputed_at = now(), dispute_id = ${dispute.id}, updated_at = now()
              where id = ${reg.id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.disputed", {
      registration_id: reg.id,
      dispute_id: dispute.id,
      amount_cents: dispute.amount,
    }, null);
    const [owner] = await sql<{ email: string }[]>`
      select u.email from organizations o join users u on u.id = o.created_by
      where o.id = ${reg.org_id}`;
    if (owner) {
      void sendDisputeAlertEmail({
        to: owner.email,
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        displayName: reg.display_name,
        amountCents: dispute.amount,
        currency: reg.currency ?? "gbp",
        refCode: reg.ref_code,
      }).catch(() => {});
    }
    return;
  }
  if (dispute.status === "won") {
    await sql`update registrations set disputed_at = null, updated_at = now()
              where id = ${reg.id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.dispute_won", {
      registration_id: reg.id,
      dispute_id: dispute.id,
    }, null);
  } else if (dispute.status === "lost") {
    await sql`update registrations
              set refunded_cents = amount_cents,
                  refunded_at = coalesce(refunded_at, now()), updated_at = now()
              where id = ${reg.id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.dispute_lost", {
      registration_id: reg.id,
      dispute_id: dispute.id,
    }, null);
  }
}

/** Mirror refunds made outside the app (Stripe dashboard) so the console
 *  never shows money we no longer hold. Monotonic — never regresses. */
export async function syncRegistrationRefund(charge: Stripe.Charge): Promise<void> {
  const intent =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;
  if (!intent) return;
  await sql`
    update registrations
    set refunded_cents = greatest(refunded_cents, ${charge.amount_refunded}),
        refunded_at = coalesce(refunded_at, now()), updated_at = now()
    where payment_intent_id = ${intent}`;
}

/**
 * Reconcile-on-return (billing.ts pattern): the status page calls this so a
 * paid registration confirms even when the webhook is delayed or missing
 * (local dev). Best-effort; never throws.
 */
export async function reconcileRegistration(regId: string, token: string): Promise<boolean> {
  try {
    const [reg] = await sql<{ status: string; checkout_session_id: string | null }[]>`
      select status, checkout_session_id from registrations
      where id = ${regId} and access_token_hash = ${hashRegistrationToken(token)}`;
    if (!reg || reg.status !== "pending" || !reg.checkout_session_id) return false;
    const session = await getStripe().checkout.sessions.retrieve(reg.checkout_session_id);
    if (session.payment_status !== "paid") return false;
    if (session.metadata?.registration_id !== regId) return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile-on-return for the token-free /r/[ref] flow (email-minted sessions,
 * spec T6): the session's own metadata must point at the ref's registration —
 * the ref is a lookup, the session is the proof. Best-effort; never throws.
 */
export async function reconcileRegistrationBySession(
  ref: string,
  sessionId: string,
): Promise<boolean> {
  try {
    const reg = await regByRef(ref);
    if (reg.status !== "pending") return false;
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return false;
    if (session.metadata?.registration_id !== reg.id) return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public: status / withdraw / resume payment (token-gated)
// ---------------------------------------------------------------------------

export interface PublicStatusView {
  id: string;
  status: string;
  /** Quotable reference (v3/05 §3); null on pre-v2 rows. */
  ref_code: string | null;
  display_name: string;
  division_name: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  starts_on: string | null;
  ends_on: string | null;
  fee_cents: number;
  amount_cents: number;
  currency: string | null;
  refunded_cents: number;
  payment_due: boolean;
  /** How this entry pays (snapshot; spec §3). */
  payment_method: "offline" | "stripe" | null;
  /** Card pendings: the pay-by deadline (spec §2). */
  expires_at: string | null;
  /** Pay CTA gate: card pending + fee due + Connect live. */
  can_pay_online: boolean;
  payment_instructions: string | null;
  /** 1-based place in the waitlist queue; null unless waitlisted (PROMPT-52). */
  position: number | null;
  created_at: string;
}

async function regByToken(regId: string, token: string): Promise<RegistrationRow> {
  const [reg] = await sql<RegistrationRow[]>`
    select ${sql(REG_COLS as unknown as string[])} from registrations
    where id = ${regId} and access_token_hash = ${hashRegistrationToken(token)}`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

export async function publicRegistrationStatus(
  regId: string,
  token: string,
): Promise<PublicStatusView> {
  const reg = await regByToken(regId, token);
  const ctx = await divisionCtx(sql, reg.division_id);
  const settings = await loadSettings(sql, reg.division_id);
  const [div] = await sql<{ name: string }[]>`
    select name from divisions where id = ${reg.division_id}`;
  // Amount due follows the SNAPSHOT (reg row), not live settings — fee edits
  // never change what an in-flight registrant owes (spec issue #8).
  const paymentDue = reg.status === "pending" && reg.amount_cents > 0;
  const offline = reg.payment_method !== "stripe";
  // Queue position (PROMPT-52): created_at-then-id order — identical to the
  // oldest-first order auto-promotion consumes, so "#N" never lies.
  // The row's own created_at is read back in SQL (not passed from JS): a JS
  // Date truncates to ms while timestamptz keeps µs, and the tuple compare
  // would then exclude the row itself.
  const [posRow] = reg.status === "waitlisted"
    ? await sql<{ position: number }[]>`
        select count(*)::int as position from registrations r
        where r.division_id = ${reg.division_id} and r.status = 'waitlisted'
          and (r.created_at, r.id) <=
              (select created_at, id from registrations where id = ${reg.id})`
    : [];
  return {
    id: reg.id,
    status: reg.status,
    ref_code: reg.ref_code,
    display_name: reg.display_name,
    division_name: div?.name ?? "",
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    org_name: ctx.org_name,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    fee_cents: settings?.fee_cents ?? 0,
    amount_cents: reg.amount_cents,
    currency: reg.currency,
    refunded_cents: reg.refunded_cents,
    payment_due: paymentDue,
    payment_method: reg.payment_method,
    expires_at: reg.expires_at ? new Date(reg.expires_at).toISOString() : null,
    can_pay_online: paymentDue && !offline && ctx.charges_enabled,
    payment_instructions:
      paymentDue && offline
        ? (settings?.payment_instructions ?? ctx.payment_instructions)
        : null,
    position: posRow?.position ?? null,
    created_at: new Date(reg.created_at).toISOString(),
  };
}

/** Registrant withdraw (token). Frees the spot, auto-promotes the oldest
 *  waitlisted, auto-refunds before refund_lock_at (doc 16 §1.1). */
export async function withdrawRegistrationPublic(
  regId: string,
  token: string,
): Promise<PublicStatusView> {
  const reg = await regByToken(regId, token);
  await withdrawCore(reg, null);
  return publicRegistrationStatus(regId, token);
}

// ---------------------------------------------------------------------------
// Reference-number lookups — /r/[ref] (v3/05 §3, PROMPT-34)
// ---------------------------------------------------------------------------

/** What /r/[ref] shows the world: never more than the success screen, and
 *  the name honours the division's public name display (v3/11 gap 8). */
export interface PublicRefView {
  ref_code: string;
  status: string;
  display_name: string;
  division_name: string;
  division_slug: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  org_name: string;
  starts_on: string | null;
  ends_on: string | null;
  created_at: string;
  /** True when the ?token= the viewer presented matches — unlocks withdraw. */
  can_withdraw: boolean;
}

async function regByRef(ref: string): Promise<RegistrationRow> {
  // Checksum rejects typos before the DB sees them; normalise dashes/case so
  // "sz abcd efgh" read over a phone still resolves.
  const canonical = normalizeRefCode(ref);
  if (!isValidRefCode(canonical)) throw new HttpError(404, "registration not found");
  const [reg] = await sql<RegistrationRow[]>`
    select ${sql(REG_COLS as unknown as string[])} from registrations
    where ref_code = ${canonical}`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

export async function publicRegistrationStatusByRef(
  ref: string,
  token?: string | null,
): Promise<PublicRefView> {
  const reg = await regByRef(ref);
  const ctx = await divisionCtx(sql, reg.division_id);
  const [div] = await sql<
    { name: string; slug: string; youth: boolean; player_name_display: string | null }[]
  >`
    select name, slug, youth, player_name_display from divisions
    where id = ${reg.division_id}`;
  const mode = resolveNameDisplay(div?.player_name_display ?? null, div?.youth ?? false);
  const canWithdraw =
    !!token &&
    reg.status !== "withdrawn" &&
    hashRegistrationToken(token) ===
      (await sql<{ access_token_hash: string }[]>`
        select access_token_hash from registrations where id = ${reg.id}`)[0]!.access_token_hash;
  return {
    ref_code: reg.ref_code!,
    status: reg.status,
    display_name: maskDisplayName(reg.display_name, mode),
    division_name: div?.name ?? "",
    division_slug: div?.slug ?? "",
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    org_name: ctx.org_name,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    created_at: new Date(reg.created_at).toISOString(),
    can_withdraw: canWithdraw,
  };
}

/** Self-withdraw from /r/[ref] — the ref is a lookup, NOT auth: the email
 *  token is still required (v3/05 §4). */
export async function withdrawRegistrationByRef(
  ref: string,
  token: string,
): Promise<PublicRefView> {
  const reg = await regByRef(ref);
  const byToken = await regByToken(reg.id, token); // 404s on a bad token
  await withdrawCore(byToken, null);
  return publicRegistrationStatusByRef(ref, token);
}

/** Resume/complete payment from the status page (pending paid regs — fresh
 *  submissions whose checkout was abandoned, and waitlist promotions). */
export async function resumeRegistrationCheckout(
  regId: string,
  token: string,
  origin: string,
): Promise<{ checkout_url: string }> {
  const reg = await regByToken(regId, token);
  if (reg.status !== "pending") {
    throw new HttpError(422, `Nothing to pay — registration is ${reg.status}`);
  }
  if (reg.payment_method !== "stripe") {
    throw new HttpError(422, "This entry fee is paid directly to the organiser");
  }
  if (reg.amount_cents <= 0) {
    throw new HttpError(422, "This registration has no entry fee");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const url = await createRegistrationCheckout(reg, ctx, origin, token);
  return { checkout_url: url };
}

// ---------------------------------------------------------------------------
// Withdraw core + refunds (shared by public + organiser paths)
// ---------------------------------------------------------------------------

/** Refund a payment taken as a destination charge: money comes back off the
 *  connected account, the platform returns its application fee. */
async function stripeRefund(
  paymentIntentId: string,
  amountCents: number | undefined,
): Promise<Stripe.Refund> {
  return getStripe().refunds.create({
    payment_intent: paymentIntentId,
    ...(amountCents !== undefined ? { amount: amountCents } : {}),
    reverse_transfer: true,
    refund_application_fee: true,
  });
}

/** Fire-and-forget refund receipt to the registrant (spec T9). */
function notifyRefund(reg: RegistrationRow, ctx: DivisionCtx, amountCents: number): void {
  void sendRefundIssuedEmail({
    to: reg.contact_email,
    orgName: ctx.org_name,
    competitionName: ctx.comp_name,
    displayName: reg.display_name,
    amountCents,
    currency: reg.currency ?? "gbp",
    refCode: reg.ref_code,
  }).catch(() => {});
}

async function withdrawCore(reg: RegistrationRow, actorId: string | null): Promise<void> {
  if (reg.status === "withdrawn") return; // idempotent
  const settings = await loadSettings(sql, reg.division_id);
  const ctx = await divisionCtx(sql, reg.division_id);

  const outcome = (await sql.begin(async (tx) => {
    const [locked] = await tx<RegistrationRow[]>`
      select ${sql(REG_COLS as unknown as string[])} from registrations
      where id = ${reg.id} for update`;
    if (!locked || locked.status === "withdrawn") return null;
    const freedSpot = (SPOT_HOLDERS as readonly string[]).includes(locked.status);
    await tx`
      update registrations
      set status = 'withdrawn', withdrawn_at = now(), updated_at = now()
      where id = ${reg.id}`;
    // A withdrawn entrant that was already materialised marks withdrawn too —
    // fixtures/standings handle entrant withdrawal by the existing rules.
    if (locked.entrant_id) {
      await tx`update entrants set status = 'withdrawn' where id = ${locked.entrant_id}`;
    }
    const promoted = freedSpot
      ? await promoteOldestWaitlisted(tx, reg.division_id, settings)
      : null;
    await audit(tx, ctx.competition_id, ctx.org_id, "registration.withdrawn", {
      registration_id: reg.id,
      by: actorId ? "organiser" : "registrant",
      promoted_registration_id: promoted?.id ?? null,
    }, actorId);
    if (promoted) {
      await audit(tx, ctx.competition_id, ctx.org_id, "registration.promoted", {
        registration_id: promoted.id,
        from: "waitlist",
      }, actorId);
    }
    return { locked, promoted };
  })) as unknown as { locked: RegistrationRow; promoted: RegistrationRow | null } | null;
  if (!outcome) return;

  fireDivisionRevalidate(reg.division_id, ctx.competition_id);
  if (outcome.promoted) {
    void notifyPromoted(outcome.promoted, ctx, settings, fallbackOrigin());
  }

  // Auto-refund policy (doc 16 §1.1): full refund when withdrawal lands
  // before refund_lock_at (or no lock set). After the lock it's organiser
  // discretion via the manual refund endpoint. Stripe call OUTSIDE the tx.
  const { locked } = outcome;
  const refundable = locked.payment_intent_id && locked.refunded_cents < locked.amount_cents;
  const beforeLock =
    !settings?.refund_lock_at || new Date() < new Date(settings.refund_lock_at);
  if (refundable && beforeLock) {
    try {
      const refund = await stripeRefund(locked.payment_intent_id as string, undefined);
      await sql`
        update registrations
        set refunded_cents = amount_cents, refunded_at = now(), updated_at = now()
        where id = ${reg.id}`;
      await audit(sql, ctx.competition_id, ctx.org_id, "registration.refunded", {
        registration_id: reg.id,
        amount_cents: locked.amount_cents,
        mode: "auto",
        stripe_refund_id: refund.id,
      }, actorId);
      notifyRefund(locked, ctx, locked.amount_cents);
    } catch {
      // Refund failure must not undo the withdrawal — surfaces on the
      // organiser console (withdrawn + refunded_cents < amount_cents).
      await audit(sql, ctx.competition_id, ctx.org_id, "registration.refund_failed", {
        registration_id: reg.id,
        mode: "auto",
      }, actorId);
    }
  }
}

// ---------------------------------------------------------------------------
// Pay-window sweep (spec §6) — cron-shaped: /api/cron/registrations, hourly
// ---------------------------------------------------------------------------

/**
 * Two passes over card pendings: (1) T-24h payment reminders carrying a fresh
 * token-free checkout link, exactly once per registration (reminded_at);
 * (2) expire rows past their deadline and promote the oldest waitlisted with
 * a new window. Each expiry runs in its own row-locked tx, so a racing
 * webhook serialises: webhook first → paid wins; sweep first → the late
 * payment auto-refunds (confirmPaidRegistration).
 */
export async function sweepRegistrations(
  origin: string,
): Promise<{ reminded: number; expired: number; promoted: number }> {
  let reminded = 0;
  let expired = 0;
  let promotedCount = 0;

  const due = await sql<RegistrationRow[]>`
    select ${sql(REG_COLS as unknown as string[])} from registrations
    where status = 'pending' and payment_method = 'stripe'
      and expires_at is not null
      and expires_at < now() + interval '24 hours'
      and expires_at > now()
      and reminded_at is null
    order by expires_at
    limit 200`;
  for (const reg of due) {
    try {
      const ctx = await divisionCtx(sql, reg.division_id);
      if (!ctx.charges_enabled) continue; // Connect broke — nothing to link to
      const url = await createRegistrationCheckout(reg, ctx, origin, null);
      await sendPaymentReminderEmail({
        to: reg.contact_email,
        orgName: ctx.org_name,
        competitionName: ctx.comp_name,
        displayName: reg.display_name,
        feeCents: reg.amount_cents,
        currency: reg.currency ?? "gbp",
        paymentInstructions: null,
        checkoutUrl: url,
        payDeadline: reg.expires_at,
      });
    } catch {
      continue; // reminded_at stays null — the next sweep retries
    }
    await sql`update registrations set reminded_at = now(), updated_at = now()
              where id = ${reg.id}`;
    reminded++;
  }

  const overdue = await sql<{ id: string; division_id: string }[]>`
    select id, division_id from registrations
    where status = 'pending' and expires_at is not null and expires_at < now()
    order by expires_at
    limit 200`;
  for (const { id, division_id } of overdue) {
    const outcome = (await sql.begin(async (tx) => {
      const [locked] = await tx<RegistrationRow[]>`
        select ${sql(REG_COLS as unknown as string[])} from registrations
        where id = ${id} for update`;
      if (
        !locked ||
        locked.status !== "pending" ||
        !locked.expires_at ||
        new Date(locked.expires_at) > new Date()
      ) {
        return null; // a webhook won the race, or the deadline moved
      }
      await tx`update registrations set status = 'expired', updated_at = now()
               where id = ${id}`;
      const settings = await loadSettings(tx, division_id);
      const [div] = await tx<{ competition_id: string; org_id: string }[]>`
        select competition_id, org_id from divisions where id = ${division_id}`;
      const promoted = await promoteOldestWaitlisted(tx, division_id, settings);
      await audit(tx, div.competition_id, div.org_id, "registration.expired", {
        registration_id: id,
        promoted_registration_id: promoted?.id ?? null,
      }, null);
      if (promoted) {
        await audit(tx, div.competition_id, div.org_id, "registration.promoted", {
          registration_id: promoted.id,
          from: "waitlist",
        }, null);
      }
      return { promoted, settings, competitionId: div.competition_id };
    })) as unknown as {
      promoted: RegistrationRow | null;
      settings: RegistrationSettingsRow | null;
      competitionId: string;
    } | null;
    if (!outcome) continue;
    expired++;
    fireDivisionRevalidate(division_id, outcome.competitionId);
    if (outcome.promoted) {
      promotedCount++;
      const ctx = await divisionCtx(sql, division_id);
      await notifyPromoted(outcome.promoted, ctx, outcome.settings, origin);
    }
  }

  return { reminded, expired, promoted: promotedCount };
}

// ---------------------------------------------------------------------------
// Organiser: list / confirm / waitlist / withdraw / refund / export
// ---------------------------------------------------------------------------

export async function listRegistrations(
  auth: AuthCtx,
  divisionId: string,
  status: string | null,
): Promise<RegistrationRow[]> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    return tx<RegistrationRow[]>`
      select ${sql(REG_COLS as unknown as string[])} from registrations
      where division_id = ${divisionId}
        ${status ? tx`and status = ${status}` : tx``}
      order by created_at, id`;
  });
}

async function orgReg(tx: Tx, regId: string): Promise<RegistrationRow> {
  const [reg] = await tx<RegistrationRow[]>`
    select ${sql(REG_COLS as unknown as string[])} from registrations
    where id = ${regId} for update`;
  if (!reg) throw new HttpError(404, "registration not found");
  return reg;
}

/** Organiser approve (free regs and waitlist overrides). Paid-division regs
 *  must be paid first — confirming an unpaid one would gift the spot. */
export async function confirmRegistration(auth: AuthCtx, regId: string): Promise<RegistrationRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status === "confirmed") return reg;
    if (reg.status === "withdrawn") throw new HttpError(422, "registration is withdrawn");
    const settings = await loadSettings(tx, reg.division_id);
    if ((settings?.fee_cents ?? 0) > 0 && reg.status !== "paid" && reg.payment_intent_id === null) {
      throw new HttpError(
        422,
        "Awaiting payment — use Mark paid once the fee arrives, or Confirm without payment to waive it",
      );
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    await assertCompetitionNotFrozen(auth.orgId, div.competition_id, tx);
    await materialise(tx, reg, settings?.entrant_kind ?? "individual");
    await audit(tx, div.competition_id, auth.orgId, "registration.confirmed", {
      registration_id: regId,
      paid: reg.status === "paid",
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  return row;
}

/** Organiser: record an offline (cash/bank) payment — confirms in the same tx
 *  (payment = approval, spec §2). Card-paid rows are refused: their money
 *  trail lives on Stripe and must stay refundable there. */
export async function markRegistrationPaidOffline(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status !== "pending") {
      throw new HttpError(422, `Only pending registrations can be marked paid (this one is ${reg.status})`);
    }
    if (reg.payment_intent_id) {
      throw new HttpError(422, "This registration was paid by card — refund it on the payments trail instead");
    }
    const settings = await loadSettings(tx, reg.division_id);
    if ((settings?.fee_cents ?? 0) <= 0) {
      throw new HttpError(422, "This division has no entry fee");
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    await assertCompetitionNotFrozen(auth.orgId, div.competition_id, tx);
    await tx`
      update registrations
      set status = 'paid', offline_marked_paid_at = now(),
          offline_marked_paid_by = ${auth.userId}, updated_at = now()
      where id = ${regId}`;
    await materialise(tx, { ...reg, status: "paid" }, settings?.entrant_kind ?? "individual");
    await audit(tx, div.competition_id, auth.orgId, "registration.offline_paid", {
      registration_id: regId,
      amount_cents: reg.amount_cents,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  return row;
}

/** Organiser: confirm while waiving the fee (comped entry) — audited. */
export async function confirmRegistrationWaived(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status === "confirmed") return orgRegAfter(tx, regId);
    if (!["pending", "waitlisted"].includes(reg.status)) {
      throw new HttpError(422, `Cannot confirm a ${reg.status} registration`);
    }
    const settings = await loadSettings(tx, reg.division_id);
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    await assertCompetitionNotFrozen(auth.orgId, div.competition_id, tx);
    await materialise(tx, reg, settings?.entrant_kind ?? "individual");
    await audit(tx, div.competition_id, auth.orgId, "registration.fee_waived", {
      registration_id: regId,
      fee_cents: settings?.fee_cents ?? 0,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  return row;
}

/** Organiser: email an unpaid (offline) registrant a payment reminder. */
export async function sendPaymentReminder(
  auth: AuthCtx,
  regId: string,
): Promise<{ sent: boolean }> {
  const reg = await withTenant(auth.orgId, (tx) => orgReg(tx, regId));
  const settings = await loadSettings(sql, reg.division_id);
  const fee = settings?.fee_cents ?? 0;
  if (fee <= 0) throw new HttpError(422, "This division has no entry fee.");
  if (reg.status !== "pending") {
    throw new HttpError(422, "Payment reminders only apply to pending registrations.");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  const sent = await sendPaymentReminderEmail({
    to: reg.contact_email,
    orgName: ctx.org_name,
    competitionName: ctx.comp_name,
    displayName: reg.display_name,
    feeCents: fee,
    currency: settings?.currency ?? reg.currency ?? "gbp",
    // Division override first, org-wide fallback — same resolution as the
    // confirmation email; refCode personalises {{reference}}.
    paymentInstructions: settings?.payment_instructions ?? ctx.payment_instructions,
    refCode: reg.ref_code,
  });
  await withTenant(auth.orgId, (tx) =>
    audit(tx, ctx.competition_id, auth.orgId, "registration.payment_reminded", { registration_id: regId }, auth.userId),
  );
  return { sent };
}

async function orgRegAfter(tx: Tx, regId: string): Promise<RegistrationRow> {
  const [reg] = await tx<RegistrationRow[]>`
    select ${sql(REG_COLS as unknown as string[])} from registrations where id = ${regId}`;
  return reg;
}

/** Organiser: push a pending registration to the waitlist. */
export async function waitlistRegistration(auth: AuthCtx, regId: string): Promise<RegistrationRow> {
  return withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status !== "pending") {
      throw new HttpError(422, `Only pending registrations can be waitlisted (this one is ${reg.status})`);
    }
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    await tx`
      update registrations set status = 'waitlisted', updated_at = now()
      where id = ${regId}`;
    await audit(tx, div.competition_id, auth.orgId, "registration.waitlisted", {
      registration_id: regId,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
}

/** Organiser withdraw — same core as the registrant path (audited actor). */
export async function withdrawRegistrationOrganiser(
  auth: AuthCtx,
  regId: string,
): Promise<RegistrationRow> {
  const reg = await withTenant(auth.orgId, async (tx) => orgReg(tx, regId));
  await withdrawCore(reg, auth.userId);
  return withTenant(auth.orgId, async (tx) => orgRegAfter(tx, regId));
}

/** Manual refund (post-lock organiser discretion; partial allowed). */
export async function refundRegistration(
  auth: AuthCtx,
  regId: string,
  amountCents: number | undefined,
): Promise<RegistrationRow> {
  const reg = await withTenant(auth.orgId, async (tx) => orgReg(tx, regId));
  if (!reg.payment_intent_id) throw new HttpError(422, "No payment to refund");
  const remaining = reg.amount_cents - reg.refunded_cents;
  if (remaining <= 0) throw new HttpError(422, "Already fully refunded");
  const amount = amountCents ?? remaining;
  if (amount > remaining) {
    throw new HttpError(422, `Refund exceeds the remaining ${remaining} cents`);
  }
  const refund = await stripeRefund(reg.payment_intent_id, amount);
  const row = await withTenant(auth.orgId, async (tx) => {
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    await tx`
      update registrations
      set refunded_cents = refunded_cents + ${amount}, refunded_at = now(), updated_at = now()
      where id = ${regId}`;
    await audit(tx, div.competition_id, auth.orgId, "registration.refunded", {
      registration_id: regId,
      amount_cents: amount,
      mode: "manual",
      stripe_refund_id: refund.id,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  notifyRefund(reg, await divisionCtx(sql, reg.division_id), amount);
  return row;
}

/** CSV export (organiser console; `exports` is the Pro gate, doc 10 §1). */
export async function exportRegistrationsCsv(auth: AuthCtx, divisionId: string): Promise<string> {
  await requireFeature(auth.orgId, "exports");
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const settings = await loadSettings(tx, divisionId);
    const fieldKeys = (settings?.form_fields ?? []).map((f) => f.key);
    const rows = await tx<RegistrationRow[]>`
      select ${sql(REG_COLS as unknown as string[])} from registrations
      where division_id = ${divisionId}
      order by created_at, id`;
    const esc = (v: unknown): string => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      "id", "status", "display_name", "contact_email", "dob", "gender",
      "guardian_name", "guardian_consent", "amount_cents", "currency",
      "refunded_cents", "created_at", ...fieldKeys,
    ];
    const lines = rows.map((r) =>
      [
        r.id, r.status, r.display_name, r.contact_email, r.dob ?? "",
        r.gender ?? "", r.guardian_name ?? "", r.guardian_consent,
        r.amount_cents, r.currency ?? "", r.refunded_cents,
        new Date(r.created_at).toISOString(),
        ...fieldKeys.map((k) => (r.answers as Record<string, unknown>)[k] ?? ""),
      ].map(esc).join(","),
    );
    return [header.join(","), ...lines].join("\n") + "\n";
  });
}

// ---------------------------------------------------------------------------
// .ics confirmation attachment (doc 16 §1.1 / PROMPT-20a item 3)
// ---------------------------------------------------------------------------

/** Minimal all-day VEVENT for the competition dates. */
export async function registrationIcs(regId: string, token: string): Promise<string> {
  const view = await publicRegistrationStatus(regId, token);
  const start = (view.starts_on ?? new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  // DTEND is exclusive for all-day events.
  const endDate = view.ends_on ?? view.starts_on ?? new Date().toISOString().slice(0, 10);
  const end = new Date(new Date(`${endDate}T00:00:00Z`).getTime() + 86_400_000)
    .toISOString().slice(0, 10).replace(/-/g, "");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//seazn.club//registration//EN",
    "BEGIN:VEVENT",
    `UID:registration-${view.id}@seazn.club`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${start}`,
    `DTEND;VALUE=DATE:${end}`,
    `SUMMARY:${view.competition_name} — ${view.division_name}`,
    `DESCRIPTION:Registration for ${view.display_name} (${view.status})`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}
