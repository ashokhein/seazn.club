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
import { getStripe } from "@/lib/stripe";
import { sendRegistrationEmail, sendPaymentReminderEmail } from "@/lib/email";
import type { AuthCtx } from "@/server/api-v1/auth";
import type {
  PublicRegisterRequest,
  PutRegistrationSettings,
  RegistrationFormField,
} from "@/server/api-v1/schemas";
import { fireDivisionRevalidate } from "@/server/public-site/revalidate";
import { assertCompetitionNotFrozen } from "./entitlement-freeze";

type Tx = postgres.TransactionSql;

// ---------------------------------------------------------------------------
// Pure helpers — fee math & eligibility (unit-tested directly)
// ---------------------------------------------------------------------------

export const REGISTRATION_TOKEN_PREFIX = "rg_";

/** Platform's cut of an entry fee, in percent (doc 16 §1.1 second revenue
 *  line). Config, not code: PLATFORM_FEE_PERCENT, default 5. */
export function platformFeePercent(): number {
  const raw = Number(process.env.PLATFORM_FEE_PERCENT ?? "5");
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 5;
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
  updated_at: Date | null;
}

export interface RegistrationRow {
  id: string;
  division_id: string;
  org_id: string;
  status: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn";
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
  checkout_session_id: string | null;
  payment_intent_id: string | null;
  refunded_cents: number;
  refunded_at: Date | null;
  entrant_id: string | null;
  promoted_at: Date | null;
  withdrawn_at: Date | null;
  created_at: Date;
}

const REG_COLS = [
  "id", "division_id", "org_id", "status", "display_name", "contact_email",
  "dob", "gender", "guardian_name", "guardian_consent", "answers", "roster",
  "amount_cents", "currency", "checkout_session_id", "payment_intent_id",
  "refunded_cents", "refunded_at", "entrant_id", "promoted_at",
  "withdrawn_at", "created_at",
] as const;

const SETTINGS_COLS = [
  "division_id", "enabled", "entrant_kind", "opens_at", "closes_at",
  "capacity", "fee_cents", "currency", "refund_lock_at", "form_fields",
  "updated_at",
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
    set entrant_id = ${entrant.id}, status = 'confirmed', updated_at = now()
    where id = ${reg.id}`;
  return entrant.id;
}

/** Oldest waitlisted → pending (doc 16 §1.1 auto-promotion). The promoted
 *  registrant re-enters the normal flow: free = organiser confirm, paid =
 *  pay from the status page. Returns the promoted row when one existed. */
async function promoteOldestWaitlisted(
  tx: Tx,
  divisionId: string,
): Promise<RegistrationRow | null> {
  const [row] = await tx<RegistrationRow[]>`
    update registrations
    set status = 'pending', promoted_at = now(), updated_at = now()
    where id = (
      select id from registrations
      where division_id = ${divisionId} and status = 'waitlisted'
      order by created_at, id limit 1
      for update skip locked)
    returning ${sql(REG_COLS as unknown as string[])}`;
  return row ?? null;
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
  updated_at: null,
};

export async function getRegistrationSettings(
  auth: AuthCtx,
  divisionId: string,
): Promise<RegistrationSettingsRow & { charges_enabled: boolean }> {
  const [{ charges_enabled }] = await sql<{ charges_enabled: boolean }[]>`
    select stripe_charges_enabled as charges_enabled from organizations
    where id = ${auth.orgId}`;
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx`select 1 from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const row = await loadSettings(tx, divisionId);
    return { division_id: divisionId, ...DEFAULT_SETTINGS, ...(row ?? {}), charges_enabled };
  });
}

export async function putRegistrationSettings(
  auth: AuthCtx,
  divisionId: string,
  input: PutRegistrationSettings,
): Promise<RegistrationSettingsRow & { charges_enabled: boolean }> {
  await requireFeature(auth.orgId, "registration.enabled");
  // Entry fees are the paid layer (doc 16 §1.1). Gate at the WRITE: a
  // Community org can never save a fee, so public submit stays simple.
  if (input.fee_cents > 0) await requireFeature(auth.orgId, "registration.paid");

  // Capacity can't promise more than the plan's entrant quota (doc 10 §1) —
  // confirm would hit the wall after money changed hands.
  if (input.capacity != null) {
    const limit = await getLimit(auth.orgId, "entrants.per_division.max");
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

  const [{ charges_enabled }] = await sql<{ charges_enabled: boolean }[]>`
    select stripe_charges_enabled as charges_enabled from organizations
    where id = ${auth.orgId}`;

  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) throw new HttpError(404, "division not found");
    const [row] = await tx<RegistrationSettingsRow[]>`
      insert into registration_settings
        (division_id, enabled, entrant_kind, opens_at, closes_at, capacity,
         fee_cents, currency, refund_lock_at, form_fields, updated_at)
      values
        (${divisionId}, ${input.enabled}, ${input.entrant_kind},
         ${input.opens_at ?? null}, ${input.closes_at ?? null},
         ${input.capacity ?? null}, ${input.fee_cents}, ${input.currency},
         ${input.refund_lock_at ?? null}, ${tx.json(input.form_fields as never)}, now())
      on conflict (division_id) do update set
        enabled        = excluded.enabled,
        entrant_kind   = excluded.entrant_kind,
        opens_at       = excluded.opens_at,
        closes_at      = excluded.closes_at,
        capacity       = excluded.capacity,
        fee_cents      = excluded.fee_cents,
        currency       = excluded.currency,
        refund_lock_at = excluded.refund_lock_at,
        form_fields    = excluded.form_fields,
        updated_at     = now()
      returning ${sql(SETTINGS_COLS as unknown as string[])}`;
    return { ...row, charges_enabled };
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
  opens_at: string | null;
  closes_at: string | null;
  capacity: number | null;
  remaining: number | null;
  open: boolean;
  closed_reason: string | null;
  requires_dob: boolean;
  form_fields: RegistrationFormField[];
}

export interface PublicRegistrationInfoResult {
  competition: { id: string; name: string; slug: string };
  divisions: PublicDivisionInfo[];
}

/** The public register panel (superuser read; public/unlisted comps only). */
export async function publicRegistrationInfo(
  orgSlug: string,
  compSlug: string,
): Promise<PublicRegistrationInfoResult> {
  const [comp] = await sql<
    { id: string; name: string; slug: string; org_id: string; charges_enabled: boolean }[]
  >`
    select c.id, c.name, c.slug, c.org_id, o.stripe_charges_enabled as charges_enabled
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
      active: number;
    })[]
  >`
    select rs.*, d.name, d.slug, d.sport_key, d.eligibility,
           (select count(*)::int from registrations r
             where r.division_id = rs.division_id
               and r.status in ${sql([...SPOT_HOLDERS])}) as active
    from registration_settings rs
    join divisions d on d.id = rs.division_id
    where d.competition_id = ${comp.id} and rs.enabled
    order by d.name`;

  const now = new Date();
  const divisions: PublicDivisionInfo[] = rows.map((r) => {
    const remaining =
      r.capacity === null ? null : Math.max(0, r.capacity - r.active);
    const open = windowOpen(r, now);
    // Paid divisions stay open without Stripe — entry fees are collected
    // offline (cash / bank transfer) while Connect is disabled.
    let reason: string | null = open ? null : "window";
    if (open && remaining === 0) reason = "full"; // still open — joins the waitlist
    return {
      division_id: r.division_id,
      name: r.name,
      slug: r.slug,
      sport_key: r.sport_key,
      entrant_kind: r.entrant_kind,
      fee_cents: r.fee_cents,
      currency: r.currency,
      opens_at: r.opens_at ? new Date(r.opens_at).toISOString() : null,
      closes_at: r.closes_at ? new Date(r.closes_at).toISOString() : null,
      capacity: r.capacity,
      remaining,
      open,
      closed_reason: reason,
      requires_dob: requiresDob(r.eligibility ?? []),
      form_fields: r.form_fields ?? [],
    };
  });
  return { competition: { id: comp.id, name: comp.name, slug: comp.slug }, divisions };
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

  // Stripe Connect is disabled for now: paid divisions collect the entry fee
  // offline (cash / bank transfer). The submission is accepted immediately and
  // the organiser's payment instructions are shown + emailed to the registrant.
  const paid = settings.fee_cents > 0;

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
      const [row] = await tx<RegistrationRow[]>`
        insert into registrations
          (division_id, status, display_name, contact_email, dob, gender,
           guardian_name, guardian_consent, answers, roster, amount_cents, currency,
           access_token_hash)
        values
          (${input.division_id}, ${waitlisted ? "waitlisted" : "pending"},
           ${input.display_name}, ${input.contact_email}, ${input.dob ?? null},
           ${input.gender ?? null}, ${input.guardian_name ?? null},
           ${input.guardian_consent}, ${tx.json(answers as never)},
           ${tx.json(roster as never)},
           ${waitlisted ? 0 : settings.fee_cents}, ${settings.currency},
           ${hashRegistrationToken(secret)})
        returning ${sql(REG_COLS as unknown as string[])}`;
      await audit(tx, ctx.competition_id, ctx.org_id, "registration.submitted", {
        registration_id: row.id,
        division_id: input.division_id,
        status: row.status,
        fee_cents: row.amount_cents,
      }, null);
      return row;
    })) as unknown as RegistrationRow;

  // Confirmation email (offline flow) — includes the cash/bank instructions
  // for paid entries. Fire-and-forget: a mail hiccup must not fail the signup.
  const statusUrl =
    `${origin}/shared/${ctx.org_slug}/${ctx.comp_slug}/register/status` +
    `?rid=${reg.id}&token=${encodeURIComponent(secret)}`;
  void sendRegistrationEmail({
    to: reg.contact_email,
    orgName: ctx.org_name,
    competitionName: ctx.comp_name,
    displayName: reg.display_name,
    status: reg.status,
    feeCents: paid ? settings.fee_cents : 0,
    currency: settings.currency,
    paymentInstructions: paid && reg.status !== "waitlisted" ? ctx.payment_instructions : null,
    statusUrl,
  }).catch(() => {});

  // Stripe checkout is disabled — offline payment only.
  return { registration: reg, access_token: secret, checkout_url: null };
}

/** Destination charge on the org's Connect account; the platform keeps
 *  application_fee_amount (doc 16 §1.1). */
async function createRegistrationCheckout(
  reg: RegistrationRow,
  settings: RegistrationSettingsRow,
  ctx: DivisionCtx,
  token: string,
  origin: string,
): Promise<string> {
  const [org] = await sql<{ stripe_account_id: string | null }[]>`
    select stripe_account_id from organizations where id = ${ctx.org_id}`;
  if (!org?.stripe_account_id) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const statusUrl =
    `${origin}/shared/${ctx.org_slug}/${ctx.comp_slug}/register/status` +
    `?rid=${reg.id}&token=${encodeURIComponent(token)}`;
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    customer_email: reg.contact_email,
    metadata: { kind: "registration", registration_id: reg.id, org_id: ctx.org_id },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: settings.currency,
          unit_amount: settings.fee_cents,
          product_data: { name: `${ctx.comp_name} — entry fee (${reg.display_name})` },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: applicationFeeCents(settings.fee_cents, platformFeePercent()),
      transfer_data: { destination: org.stripe_account_id },
      metadata: { registration_id: reg.id, org_id: ctx.org_id },
    },
    success_url: `${statusUrl}&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${statusUrl}&checkout=cancelled`,
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

async function confirmPaidRegistration(
  regId: string,
  paymentIntentId: string | null,
  amountTotal: number | null,
): Promise<void> {
  const done = (await sql.begin(async (tx) => {
    const [reg] = await tx<RegistrationRow[]>`
      select ${sql(REG_COLS as unknown as string[])} from registrations
      where id = ${regId} for update`;
    if (!reg) return null;
    // Idempotency + a late payment on a withdrawn registration: record the
    // intent (so refund tooling can find it) but never resurrect the row.
    if (reg.status === "confirmed" || reg.status === "paid") return null;
    if (reg.status === "withdrawn") {
      await tx`update registrations
               set payment_intent_id = coalesce(payment_intent_id, ${paymentIntentId}),
                   updated_at = now()
               where id = ${regId}`;
      return null;
    }
    const settings = await loadSettings(tx, reg.division_id);
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
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
    return { divisionId: reg.division_id, competitionId: div.competition_id };
  })) as unknown as { divisionId: string; competitionId: string } | null;
  if (done) fireDivisionRevalidate(done.divisionId, done.competitionId);
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

// ---------------------------------------------------------------------------
// Public: status / withdraw / resume payment (token-gated)
// ---------------------------------------------------------------------------

export interface PublicStatusView {
  id: string;
  status: string;
  display_name: string;
  division_name: string;
  competition_name: string;
  competition_slug: string;
  org_slug: string;
  starts_on: string | null;
  ends_on: string | null;
  fee_cents: number;
  amount_cents: number;
  currency: string | null;
  refunded_cents: number;
  payment_due: boolean;
  payment_instructions: string | null;
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
  return {
    id: reg.id,
    status: reg.status,
    display_name: reg.display_name,
    division_name: div?.name ?? "",
    competition_name: ctx.comp_name,
    competition_slug: ctx.comp_slug,
    org_slug: ctx.org_slug,
    starts_on: ctx.starts_on,
    ends_on: ctx.ends_on,
    fee_cents: settings?.fee_cents ?? 0,
    amount_cents: reg.amount_cents,
    currency: reg.currency,
    refunded_cents: reg.refunded_cents,
    payment_due: reg.status === "pending" && (settings?.fee_cents ?? 0) > 0,
    payment_instructions:
      reg.status === "pending" && (settings?.fee_cents ?? 0) > 0 ? ctx.payment_instructions : null,
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
  const settings = await loadSettings(sql, reg.division_id);
  if (!settings || settings.fee_cents <= 0) {
    throw new HttpError(422, "This registration has no entry fee");
  }
  const ctx = await divisionCtx(sql, reg.division_id);
  if (!ctx.charges_enabled) {
    throw new HttpError(503, "Payments are not set up for this organiser yet");
  }
  const url = await createRegistrationCheckout(reg, settings, ctx, token, origin);
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
    const promoted = freedSpot ? await promoteOldestWaitlisted(tx, reg.division_id) : null;
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
      throw new HttpError(422, "Awaiting payment — the registrant pays from their status page");
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
    paymentInstructions: ctx.payment_instructions,
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
  return withTenant(auth.orgId, async (tx) => {
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
