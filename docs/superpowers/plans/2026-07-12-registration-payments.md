# Registration v3 — Dual Payments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-division payment method (offline vs Stripe Connect), auto-confirm on payment, 48h pay window with cron sweep, dispute/late-payment/duplicate hardening, admin-configurable platform fee, modernized registration UI.

**Architecture:** Extend the existing PROMPT-20a machinery (`registration_settings`, `registrations`, `usecases/registrations.ts`, Connect Express destination charges) with a `payment_method` axis, an `expired` status, a `platform_settings` table, and a cron-shaped sweep endpoint. No new payment ledger — `competition_events` audit remains the money trail.

**Tech Stack:** Next.js App Router (breaking-changes fork — read `node_modules/next/dist/docs/` before unfamiliar APIs), postgres.js tagged templates, Flyway deltas, stripe-node v22, zod v4 schemas, vitest (DB-backed on :54329), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-12-registration-payments-design.md`

## Global Constraints

- Never use `payment_method_types` in Stripe calls (repo + Stripe rule).
- Destination charges keep `reverse_transfer: true, refund_application_fee: true` on every refund.
- All public registrant paths run on superuser `sql`; organiser paths on `withTenant`. Stripe network calls happen OUTSIDE `sql.begin` transactions.
- Every task ships its failing-first test (user standing rule). Run `npx vitest run <file>` from `apps/web`.
- DB-backed tests need the local :54329 recipe (memory: `project_local_test_db`); guard `if (!HAS_DB) return` in teardown.
- Fee % semantics: org override → plan entitlement → `platform_settings` → env `PLATFORM_FEE_PERCENT` → 5.
- Copy rules: registrant-facing text says "card" / "pay the organiser", never "Stripe"/"offline".
- Commit after each task: `feat(reg): …` / `fix(reg): …`; verify `npx tsc --noEmit` before final push (memory: verify-before-push).

---

### Task 1: Migration V273 — columns, expired status, platform_settings

**Files:**
- Create: `db/migration/deltas/V273__registration_payments.sql`

**Interfaces:**
- Produces: columns `registration_settings.payment_method/payment_instructions`, `organizations.default_payment_method`, `registrations.payment_method/expires_at/reminded_at/offline_marked_paid_at/offline_marked_paid_by/disputed_at/dispute_id`, status `expired`, table `platform_settings`.

- [ ] **Step 1: Write the migration**

```sql
-- V273 — registration v3 dual payments (spec 2026-07-12).
-- Per-division payment method + instructions override, org default method,
-- payment lifecycle columns (pay window, offline mark-paid, disputes), the
-- 'expired' terminal status, and the admin-editable platform_settings table.

alter table registration_settings
  add column if not exists payment_method text not null default 'offline';
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'registration_settings_payment_method_check') then
    alter table registration_settings add constraint registration_settings_payment_method_check
      check (payment_method in ('offline','stripe'));
  end if;
end $$;
alter table registration_settings add column if not exists payment_instructions text;
-- Align the column default with the app default (code said gbp, schema said usd).
alter table registration_settings alter column currency set default 'gbp';

alter table organizations
  add column if not exists default_payment_method text not null default 'offline';
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'organizations_default_payment_method_check') then
    alter table organizations add constraint organizations_default_payment_method_check
      check (default_payment_method in ('offline','stripe'));
  end if;
end $$;

alter table registrations add column if not exists payment_method text;
do $$ begin
  if not exists (select 1 from pg_constraint
                 where conname = 'registrations_payment_method_check') then
    alter table registrations add constraint registrations_payment_method_check
      check (payment_method in ('offline','stripe'));
  end if;
end $$;
alter table registrations add column if not exists expires_at timestamptz;
alter table registrations add column if not exists reminded_at timestamptz;
alter table registrations add column if not exists offline_marked_paid_at timestamptz;
alter table registrations add column if not exists offline_marked_paid_by uuid references users(id);
alter table registrations add column if not exists disputed_at timestamptz;
alter table registrations add column if not exists dispute_id text;

-- New terminal status: expired (unpaid card registration past its pay window).
alter table registrations drop constraint if exists registrations_status_check;
alter table registrations add constraint registrations_status_check
  check (status in ('pending','paid','confirmed','waitlisted','withdrawn','expired'));

-- Sweep index: only card pendings carry expires_at.
create index if not exists registrations_expiry_idx
  on registrations(expires_at) where status = 'pending' and expires_at is not null;

-- Platform-wide admin settings (superuser access only — no app_user grant, no RLS
-- needed: never exposed to tenant connections or the Data API).
create table if not exists platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id)
);
insert into platform_settings (key, value) values ('platform_fee_percent', '5'::jsonb)
on conflict (key) do nothing;
```

- [ ] **Step 2: Apply + verify**

Run: `npm run db:apply` (Flyway incremental — memory `project_apply_db_destructive`), then
`psql "$(grep DATABASE_URL apps/web/.env.local | cut -d= -f2-)" -c "set search_path=seazn_club; \d registrations" | grep -E "expires_at|payment_method|disputed"`
Expected: new columns listed; `select value from platform_settings` returns `5`.

- [ ] **Step 3: Commit** — `git commit -m "feat(reg): V273 dual-payment columns, expired status, platform_settings"`

---

### Task 2: platform-settings lib + fee chain

**Files:**
- Create: `apps/web/src/lib/platform-settings.ts`
- Modify: `apps/web/src/server/usecases/registrations.ts:45-58` (`platformFeePercent`/`feePercentFor`)
- Test: `apps/web/src/lib/__tests__/platform-settings.test.ts` (DB-backed)

**Interfaces:**
- Produces: `platformFeeDefault(): Promise<number>`, `setPlatformFeeDefault(pct: number, actorId: string): Promise<void>` (throws HttpError 422 outside 0–100), cache key `platform:fee_percent` TTL 300s.
- `feePercentFor(orgId, competitionId?)` keeps its signature; falls back to `platformFeeDefault()`.

- [ ] **Step 1: Failing test**

```ts
// apps/web/src/lib/__tests__/platform-settings.test.ts
import { describe, expect, it } from "vitest";
import { platformFeeDefault, setPlatformFeeDefault } from "@/lib/platform-settings";
// Follow the existing DB-backed suite preamble (see usecases/__tests__/registrations.test.ts)
// for HAS_DB guard + sql teardown.

describe("platform fee default", () => {
  it("reads the seeded default, honours admin writes, validates range", async () => {
    expect(await platformFeeDefault()).toBe(5);
    await setPlatformFeeDefault(7, ACTOR_USER_ID);
    expect(await platformFeeDefault()).toBe(7);           // cache invalidated
    await expect(setPlatformFeeDefault(101, ACTOR_USER_ID)).rejects.toMatchObject({ status: 422 });
    await setPlatformFeeDefault(5, ACTOR_USER_ID);        // restore
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/lib/__tests__/platform-settings.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/platform-settings.ts
import "server-only";
// Platform-wide admin knobs (spec §1). One row per key in platform_settings;
// superuser-only table. Values cache like entitlements (300s, cache-aside).
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";

const FEE_KEY = "platform_fee_percent";
const CACHE_KEY = "platform:fee_percent";
const TTL_SECONDS = 300;

function envFallback(): number {
  const raw = Number(process.env.PLATFORM_FEE_PERCENT ?? "5");
  return Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : 5;
}

/** Platform's default cut of entry fees, %. DB (admin-set) → env → 5. */
export async function platformFeeDefault(): Promise<number> {
  const cached = await cacheGet<{ v: number }>(CACHE_KEY);
  if (cached) return cached.v;
  const [row] = await sql<{ value: unknown }[]>`
    select value from platform_settings where key = ${FEE_KEY}`;
  const parsed = Number(row?.value);
  const v = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : envFallback();
  await cacheSet(CACHE_KEY, { v }, TTL_SECONDS);
  return v;
}

export async function setPlatformFeeDefault(pct: number, actorId: string): Promise<void> {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new HttpError(422, "Fee percent must be between 0 and 100");
  }
  await sql`
    insert into platform_settings (key, value, updated_by)
    values (${FEE_KEY}, ${sql.json(pct)}, ${actorId})
    on conflict (key) do update
      set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
  await cacheDelPattern(CACHE_KEY);
}
```

In `registrations.ts`: delete `platformFeePercent()`; change `feePercentFor` to

```ts
import { platformFeeDefault } from "@/lib/platform-settings";

export async function feePercentFor(orgId: string, competitionId?: string): Promise<number> {
  const pct = await getLimit(orgId, "registration.fee_percent", competitionId);
  return pct == null || pct <= 0 ? platformFeeDefault() : pct;
}
```

Fix any `platformFeePercent` imports (grep; the unit test file references it — update to `platformFeeDefault` with DB mock or move assertions).

- [ ] **Step 4: Run tests** — platform-settings PASS + `npx vitest run src/server/usecases/__tests__/registrations.test.ts` PASS.
- [ ] **Step 5: Commit** — `feat(reg): admin-backed platform fee default`

---

### Task 3: Schemas + settings write path (method, instructions, validations)

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:646-722`
- Modify: `apps/web/src/server/usecases/registrations.ts` (`RegistrationSettingsRow`, `SETTINGS_COLS`, `DEFAULT_SETTINGS`, `getRegistrationSettings`, `putRegistrationSettings`)
- Test: extend `apps/web/src/server/usecases/__tests__/registrations.test.ts`

**Interfaces:**
- Produces: `RegistrationSettingsRow` gains `payment_method: "offline" | "stripe"`, `payment_instructions: string | null`. `getRegistrationSettings` response gains `org_payment_instructions: string | null`, `org_default_payment_method: string`. `PutRegistrationSettings` gains `payment_method` (default "offline") + `payment_instructions` (max 2000, nullish).

- [ ] **Step 1: Failing tests** (same suite, new cases)

```ts
it("stripe method requires charges_enabled and min fee", async () => {
  // org seeded WITHOUT stripe_charges_enabled
  await expect(putRegistrationSettings(auth, divisionId, {
    ...base, payment_method: "stripe", fee_cents: 500,
  })).rejects.toMatchObject({ status: 422 }); // "Connect …"
  await sql`update organizations set stripe_charges_enabled = true where id = ${orgId}`;
  await expect(putRegistrationSettings(auth, divisionId, {
    ...base, payment_method: "stripe", fee_cents: 50,
  })).rejects.toMatchObject({ status: 422 }); // min charge
  const ok = await putRegistrationSettings(auth, divisionId, {
    ...base, payment_method: "stripe", fee_cents: 500, payment_instructions: null,
  });
  expect(ok.payment_method).toBe("stripe");
});

it("offline fees stay plan-free and store an instructions override", async () => {
  const s = await putRegistrationSettings(auth, divisionId, {
    ...base, payment_method: "offline", fee_cents: 1500,
    payment_instructions: "Cash to the desk",
  });
  expect(s.payment_instructions).toBe("Cash to the desk");
});
```

- [ ] **Step 2: Run** — FAIL (unknown key `payment_method`).

- [ ] **Step 3: Implement**

schemas.ts:
- `RegistrationStatus` enum += `"expired"`.
- `PutRegistrationSettings` object gains:

```ts
payment_method: z.enum(["offline", "stripe"]).default("offline"),
payment_instructions: z.string().max(2000).nullish(),
```

- `RegistrationSettings` (response) gains `payment_method: z.enum(["offline","stripe"])`, `payment_instructions: z.string().nullable()`, `org_payment_instructions: z.string().nullable()`, `org_default_payment_method: z.string()`.
- `Registration` (organiser view) gains `ref_code: z.string().nullable()`, `payment_method: z.string().nullable()`, `expires_at: z.string().nullable()`, `offline_marked_paid_at: z.string().nullable()`, `disputed_at: z.string().nullable()`.
- `PublicRegistrationDivision` gains `payment_method: z.enum(["offline","stripe"])`.

registrations.ts:
- `SETTINGS_COLS` += `"payment_method", "payment_instructions"`; `REG_COLS` += `"payment_method", "expires_at", "reminded_at", "offline_marked_paid_at", "disputed_at", "dispute_id"`; extend `RegistrationSettingsRow`/`RegistrationRow` types to match.
- `DEFAULT_SETTINGS` += `payment_method: "offline" as const, payment_instructions: null`.
- `getRegistrationSettings`: select `payment_instructions as org_payment_instructions, default_payment_method as org_default_payment_method, stripe_charges_enabled as charges_enabled` from organizations in the first query; spread into the return.
- `putRegistrationSettings`: replace the old `fee_cents > 0 && charges_enabled` gate with:

```ts
if (input.payment_method === "stripe") {
  if (!charges_enabled) {
    throw new HttpError(422, "Connect Stripe under Settings → Payments before choosing card payments");
  }
  await requireFeature(auth.orgId, "registration.paid", regDiv?.competition_id);
  if (input.fee_cents > 0 && input.fee_cents < 100) {
    throw new HttpError(422, "Card entry fees must be at least 1.00 (or 0 for free)");
  }
}
```

(charges_enabled is already queried above — hoist that single query before the branch.) Add the two new columns to the upsert's insert/`do update set` lists.

- [ ] **Step 4: Run suite** — PASS. `npx tsc --noEmit` — clean.
- [ ] **Step 5: Commit** — `feat(reg): per-division payment method + instructions override`

---

### Task 4: Submit path — method snapshot, checkout at submit, pay window

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (`submitRegistration`, `createRegistrationCheckout`, `publicRegistrationInfo`, `PublicDivisionInfo`)
- Test: extend registrations suite (Stripe client mocked via `vi.mock("@/lib/stripe")` — follow the suite's existing mock if present, else add `getStripe: () => ({ checkout: { sessions: { create: vi.fn(async () => ({ id: "cs_test", url: "https://stripe.test/cs" })) } } })`)

**Interfaces:**
- Produces: `submitRegistration` returns `checkout_url` non-null for open stripe-method paid divisions; registration rows carry `payment_method` + `expires_at`. `createRegistrationCheckout(reg, ctx, origin, token | null)` — amount from `reg.amount_cents`; `token === null` → success/cancel URLs on `/r/[ref]`.
- `PublicDivisionInfo` gains `payment_method`; `closed_reason` may be `"payments_unavailable"`.

- [ ] **Step 1: Failing tests**

```ts
it("stripe-method submit snapshots method, sets a 48h window, returns checkout", async () => {
  // settings: payment_method stripe, fee 500, org charges_enabled true
  const res = await submitRegistration(orgSlug, compSlug, input, "http://localhost:3000");
  expect(res.checkout_url).toMatch(/^https:/);
  expect(res.registration.payment_method).toBe("stripe");
  expect(res.registration.expires_at).not.toBeNull();
});

it("offline submit keeps no expiry and no checkout", async () => {
  const res = await submitRegistration(orgSlug, compSlug, input, origin);
  expect(res.checkout_url).toBeNull();
  expect(res.registration.expires_at).toBeNull();
});

it("stripe submit 503s when charges are disabled, and the public panel says so", async () => {
  await sql`update organizations set stripe_charges_enabled = false where id = ${orgId}`;
  await expect(submitRegistration(...)).rejects.toMatchObject({ status: 503 });
  const info = await publicRegistrationInfo(orgSlug, compSlug);
  expect(info.divisions[0].closed_reason).toBe("payments_unavailable");
  expect(info.divisions[0].open).toBe(false);
});

it("waitlisted card submits take no window and no payment", async () => { /* capacity 1, second submit */ });
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**

`submitRegistration` — replace the hardcoded offline block:

```ts
const paid = settings.fee_cents > 0;
const useStripe = paid && settings.payment_method === "stripe";
if (useStripe && !ctx.charges_enabled) {
  throw new HttpError(503, "Card payments are temporarily unavailable for this event — try again shortly or contact the organiser");
}
```

Insert adds `payment_method` (always `settings.payment_method`) and `expires_at`:

```ts
${useStripe && !waitlisted ? sql`now() + interval '48 hours'` : null}
```

(postgres.js: use a ternary building the full insert column values — add both columns to the existing insert列 list.)

After the tx, for `useStripe && reg.status === "pending"`:

```ts
let checkoutUrl: string | null = null;
if (useStripe && reg.status === "pending") {
  try {
    checkoutUrl = await createRegistrationCheckout(reg, ctx, origin, secret);
  } catch {
    // Checkout minting must not lose the registration — the status page
    // offers Pay, and the T-24h reminder carries a fresh link.
  }
}
```

Email args gain `payOnline: useStripe`, `payDeadline: reg.expires_at` (Task 9 wires the template). `paymentInstructions` becomes the resolved override: `settings.payment_instructions ?? ctx.payment_instructions` (only for offline). Return `checkout_url: checkoutUrl`.

`createRegistrationCheckout(reg, ctx, origin, token: string | null)`:
- amount: `unit_amount: reg.amount_cents` (snapshot — drop the `settings` param).
- fee: unchanged (`applicationFeeCents(reg.amount_cents, await feePercentFor(...))`).
- URLs: token non-null → existing status-page URLs; token null → `${origin}/r/${reg.ref_code}?checkout=success&session_id={CHECKOUT_SESSION_ID}` / `?checkout=cancelled` (ref page reconciles by session in Task 6).
- callers: submit (token), `resumeRegistrationCheckout` (token; also assert `reg.payment_method === "stripe"` else 422 "This registration is paid directly to the organiser"), cron reminder (null, Task 7).

`publicRegistrationInfo`: select `rs.payment_method`; compute

```ts
const paymentsBroken = r.payment_method === "stripe" && r.fee_cents > 0 && !comp.charges_enabled;
const open = windowOpen(r, now) && !paymentsBroken;
let reason: string | null = open ? null : paymentsBroken ? "payments_unavailable" : "window";
```

and include `payment_method` in the mapped division.

- [ ] **Step 4: Run suite** — PASS.
- [ ] **Step 5: Commit** — `feat(reg): card checkout at submit + 48h pay window`

---

### Task 5: Payment completion hardening (late, duplicate, expiry-clear)

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (`confirmPaidRegistration`, `materialise`)
- Test: extend registrations suite (mock `getStripe().refunds.create`)

**Interfaces:**
- Produces: `confirmPaidRegistration` refunds late payments on `withdrawn`/`expired` rows and duplicate payment intents on `paid`/`confirmed` rows; successful confirm clears `expires_at`.

- [ ] **Step 1: Failing tests**

```ts
it("late payment on a withdrawn registration is auto-refunded", async () => {
  // withdraw the pending reg, then simulate the webhook
  await handleRegistrationCheckoutCompleted(fakeSession({ registration_id, payment_intent: "pi_late", amount_total: 500 }));
  const [row] = await sql`select status, refunded_cents, payment_intent_id from registrations where id = ${registration_id}`;
  expect(row.status).toBe("withdrawn");
  expect(row.refunded_cents).toBe(500);
  expect(refundsCreate).toHaveBeenCalledWith(expect.objectContaining({ payment_intent: "pi_late", reverse_transfer: true, refund_application_fee: true }));
});

it("a second completed session refunds the duplicate intent and keeps state", async () => { /* confirm with pi_1, replay with pi_2 → refund pi_2, row untouched */ });

it("confirm clears the pay window", async () => { /* expires_at null after confirm */ });
```

- [ ] **Step 2: Run** — FAIL (today the late payment only records the intent).
- [ ] **Step 3: Implement** — restructure `confirmPaidRegistration`:

```ts
type PayOutcome =
  | { kind: "confirmed"; divisionId: string; competitionId: string }
  | { kind: "late"; reg: RegistrationRow; competitionId: string }
  | { kind: "duplicate"; reg: RegistrationRow; competitionId: string }
  | null;
```

Inside the tx:
- `paid`/`confirmed` + `paymentIntentId && reg.payment_intent_id && paymentIntentId !== reg.payment_intent_id` → return `{ kind: "duplicate", … }` (no row change); otherwise null (pure replay).
- `withdrawn` **or `expired`** → record the intent as today, return `{ kind: "late", … }`.
- happy path → also `expires_at = null` in the paid update AND in `materialise`'s final update (`set entrant_id …, status='confirmed', expires_at = null`); return `{ kind: "confirmed", … }`.

After the tx:

```ts
if (outcome?.kind === "confirmed") fireDivisionRevalidate(outcome.divisionId, outcome.competitionId);
if (outcome?.kind === "late" || outcome?.kind === "duplicate") {
  const intent = outcome.kind === "duplicate" ? paymentIntentId! : outcome.reg.payment_intent_id ?? paymentIntentId!;
  try {
    const refund = await stripeRefund(intent, undefined);
    if (outcome.kind === "late") {
      await sql`update registrations
                set refunded_cents = ${amountTotal ?? outcome.reg.amount_cents},
                    refunded_at = now(), updated_at = now()
                where id = ${regId}`;
    }
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refunded", {
      registration_id: regId, amount_cents: amountTotal ?? outcome.reg.amount_cents,
      mode: outcome.kind === "late" ? "late_payment" : "duplicate", stripe_refund_id: refund.id,
    }, null);
  } catch {
    await audit(sql, outcome.competitionId, outcome.reg.org_id, "registration.refund_failed",
      { registration_id: regId, mode: outcome.kind }, null);
  }
}
```

(For `late`, the reg row needs `org_id` + division's competition_id — fetch inside the tx as today.)

- [ ] **Step 4: Run suite** — PASS.
- [ ] **Step 5: Commit** — `fix(reg): refund late + duplicate payments, clear pay window on confirm`

---

### Task 6: /r/[ref] session reconcile (token-free return URLs)

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (new `reconcileRegistrationBySession`)
- Modify: `apps/web/src/app/(public)/r/[ref]/page.tsx` (accept `?checkout=success&session_id=`)
- Test: registrations suite

**Interfaces:**
- Produces: `reconcileRegistrationBySession(ref: string, sessionId: string): Promise<boolean>` — retrieves the session, verifies `metadata.registration_id` matches the ref's row, then runs `handleRegistrationCheckoutCompleted`. Best-effort, never throws.

- [ ] **Step 1: Failing test** — paid session + matching ref → row confirmed; mismatched registration_id → returns false, row untouched.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (mirror `reconcileRegistration`):

```ts
export async function reconcileRegistrationBySession(ref: string, sessionId: string): Promise<boolean> {
  try {
    const reg = await regByRef(ref);
    if (reg.status !== "pending") return false;
    const session = await getStripe().checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== "paid") return false;
    if (session.metadata?.registration_id !== reg.id) return false;
    await handleRegistrationCheckoutCompleted(session);
    return true;
  } catch { return false; }
}
```

`/r/[ref]/page.tsx`: read `searchParams` `checkout`/`session_id`; when `checkout === "success" && session_id` call the reconciler before loading the view.

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(reg): token-free checkout return via /r/[ref]`

---

### Task 7: Organiser actions — mark paid (offline) + confirm-without-payment

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (new `markRegistrationPaidOffline`, `confirmRegistrationWaived`; reword `confirmRegistration` guard)
- Create: `apps/web/src/app/api/v1/registrations/[id]/mark-paid/route.ts`
- Create: `apps/web/src/app/api/v1/registrations/[id]/waive/route.ts`
- Modify: `apps/web/src/server/api-v1/key-scopes.ts` + `apps/web/src/server/api-v1/openapi.ts` if routes are registered there (grep `registrations/[id]/confirm` and mirror)
- Test: registrations suite

**Interfaces:**
- Produces: `markRegistrationPaidOffline(auth, regId): Promise<RegistrationRow>` — pending + fee>0 + no payment_intent required; sets `offline_marked_paid_at/by`, → paid → materialise → confirmed, audit `registration.offline_paid`. `confirmRegistrationWaived(auth, regId)` — pending|waitlisted; materialise without payment, audit `registration.fee_waived`.

- [ ] **Step 1: Failing tests**

```ts
it("mark-paid confirms an offline registrant and records the actor", async () => {
  const row = await markRegistrationPaidOffline(auth, regId);
  expect(row.status).toBe("confirmed");
  expect(row.offline_marked_paid_at).not.toBeNull();
});
it("mark-paid rejects card-paid and free registrations", async () => { /* 422 both */ });
it("waive confirms without payment and audits", async () => { /* status confirmed, amount untouched */ });
it("plain confirm still blocks unpaid fee-bearing registrations", async () => { /* 422 message mentions Mark paid */ });
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**

```ts
/** Organiser: record an offline (cash/bank) payment — confirms in the same tx. */
export async function markRegistrationPaidOffline(auth: AuthCtx, regId: string): Promise<RegistrationRow> {
  const row = await withTenant(auth.orgId, async (tx) => {
    const reg = await orgReg(tx, regId);
    if (reg.status !== "pending") throw new HttpError(422, `Only pending registrations can be marked paid (this one is ${reg.status})`);
    if (reg.payment_intent_id) throw new HttpError(422, "This registration was paid by card");
    const settings = await loadSettings(tx, reg.division_id);
    if ((settings?.fee_cents ?? 0) <= 0) throw new HttpError(422, "This division has no entry fee");
    const [div] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${reg.division_id}`;
    await assertCompetitionNotFrozen(auth.orgId, div.competition_id, tx);
    await tx`
      update registrations
      set status = 'paid', offline_marked_paid_at = now(), offline_marked_paid_by = ${auth.userId},
          updated_at = now()
      where id = ${regId}`;
    await materialise(tx, { ...reg, status: "paid" }, settings?.entrant_kind ?? "individual");
    await audit(tx, div.competition_id, auth.orgId, "registration.offline_paid", {
      registration_id: regId, amount_cents: reg.amount_cents,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  return row;
}

/** Organiser: confirm while waiving the fee (comped entry). */
export async function confirmRegistrationWaived(auth: AuthCtx, regId: string): Promise<RegistrationRow> {
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
      registration_id: regId, fee_cents: settings?.fee_cents ?? 0,
    }, auth.userId);
    return orgRegAfter(tx, regId);
  });
  fireDivisionRevalidate(row.division_id);
  return row;
}
```

Reword the `confirmRegistration` guard message to: `"Awaiting payment — use Mark paid once the fee arrives, or Confirm without payment to waive it"`.

Routes copy `confirm/route.ts` exactly, swapping the usecase import (`markRegistrationPaidOffline` / `confirmRegistrationWaived`).

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(reg): organiser mark-paid + fee-waive actions`

---

### Task 8: Promotion snapshot + shared promote helper + cron sweep

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (`promoteOldestWaitlisted`, `withdrawCore`, new `sweepRegistrations`)
- Create: `apps/web/src/app/api/cron/registrations/route.ts`
- Test: registrations suite + route-level test optional

**Interfaces:**
- Produces: `promoteOldestWaitlisted(tx, divisionId, settings)` — promotes AND snapshots `amount_cents = settings.fee_cents`, sets `payment_method = settings.payment_method`, `expires_at = now()+48h` when stripe+fee. `sweepRegistrations(origin): Promise<{ reminded: number; expired: number; promoted: number }>` — exported for the route + tests. Promotion emails fire post-tx (`sendRegistrationPromotedEmail`, Task 9 stubs acceptable: call guarded `catch(() => {})`).

- [ ] **Step 1: Failing tests**

```ts
it("promotion snapshots the current fee and opens a 48h window for card divisions", async () => {
  // stripe division, capacity 1: A pending, B waitlisted (amount 0). Withdraw A.
  const [b] = await sql`select status, amount_cents, expires_at, payment_method from registrations where id = ${bId}`;
  expect(b.status).toBe("pending");
  expect(b.amount_cents).toBe(500);
  expect(b.expires_at).not.toBeNull();
});

it("sweep expires overdue card pendings and promotes the waitlist", async () => {
  await sql`update registrations set expires_at = now() - interval '1 hour' where id = ${aId}`;
  const res = await sweepRegistrations("http://localhost:3000");
  expect(res.expired).toBe(1);
  const [a] = await sql`select status from registrations where id = ${aId}`;
  expect(a.status).toBe("expired");
  // waitlisted B is now pending
});

it("sweep reminds once inside the last 24h", async () => {
  await sql`update registrations set expires_at = now() + interval '10 hours' where id = ${id}`;
  expect((await sweepRegistrations(origin)).reminded).toBe(1);
  expect((await sweepRegistrations(origin)).reminded).toBe(0); // reminded_at guard
});
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**

`promoteOldestWaitlisted(tx, divisionId, settings: RegistrationSettingsRow | null)`:

```ts
const stripeWindow = settings?.payment_method === "stripe" && (settings?.fee_cents ?? 0) > 0;
const [row] = await tx<RegistrationRow[]>`
  update registrations
  set status = 'pending', promoted_at = now(), updated_at = now(),
      amount_cents = ${settings?.fee_cents ?? 0},
      payment_method = ${settings?.payment_method ?? "offline"},
      expires_at = ${stripeWindow ? tx`now() + interval '48 hours'` : null}
  where id = (…same subselect…)
  returning ${sql(REG_COLS as unknown as string[])}`;
```

`withdrawCore` already loads `settings` — pass it through. After the tx, when `outcome.promoted`, fire the promoted email (registrant contact from the promoted row; include instructions or pay deadline per method) with `.catch(() => {})`.

`sweepRegistrations(origin)`:

```ts
export async function sweepRegistrations(origin: string): Promise<{ reminded: number; expired: number; promoted: number }> {
  let reminded = 0, expired = 0, promoted = 0;

  // 1) T-24h reminders with a fresh checkout link (ref-based return URLs).
  const due = await sql<RegistrationRow[]>`
    select ${sql(REG_COLS as unknown as string[])} from registrations
    where status = 'pending' and payment_method = 'stripe'
      and expires_at is not null and expires_at < now() + interval '24 hours'
      and expires_at > now() and reminded_at is null
    order by expires_at limit 200`;
  for (const reg of due) {
    try {
      const ctx = await divisionCtx(sql, reg.division_id);
      const url = await createRegistrationCheckout(reg, ctx, origin, null);
      await sendPaymentReminderEmail({
        to: reg.contact_email, orgName: ctx.org_name, competitionName: ctx.comp_name,
        displayName: reg.display_name, feeCents: reg.amount_cents,
        currency: reg.currency ?? "gbp", paymentInstructions: null,
        checkoutUrl: url, payDeadline: reg.expires_at,
      });
    } catch { /* next sweep retries the email; reminded_at stays null on throw */ continue; }
    await sql`update registrations set reminded_at = now() where id = ${reg.id}`;
    reminded++;
  }

  // 2) Expiry + promotion, one row-locked tx per registration.
  const overdue = await sql<{ id: string; division_id: string }[]>`
    select id, division_id from registrations
    where status = 'pending' and expires_at is not null and expires_at < now()
    order by expires_at limit 200`;
  for (const { id, division_id } of overdue) {
    const outcome = (await sql.begin(async (tx) => {
      const [locked] = await tx<RegistrationRow[]>`
        select ${sql(REG_COLS as unknown as string[])} from registrations
        where id = ${id} for update`;
      if (!locked || locked.status !== "pending" || !locked.expires_at ||
          new Date(locked.expires_at) > new Date()) return null;
      await tx`update registrations set status = 'expired', updated_at = now() where id = ${id}`;
      const settings = await loadSettings(tx, division_id);
      const [div] = await tx<{ competition_id: string; org_id: string }[]>`
        select competition_id, org_id from divisions where id = ${division_id}`;
      const promotedRow = await promoteOldestWaitlisted(tx, division_id, settings);
      await audit(tx, div.competition_id, div.org_id, "registration.expired", {
        registration_id: id, promoted_registration_id: promotedRow?.id ?? null,
      }, null);
      return { promotedRow, competitionId: div.competition_id };
    })) as unknown as { promotedRow: RegistrationRow | null; competitionId: string } | null;
    if (!outcome) continue;
    expired++;
    if (outcome.promotedRow) { promoted++; /* fire promoted email as in withdrawCore */ }
    fireDivisionRevalidate(division_id, outcome.competitionId);
  }
  return { reminded, expired, promoted };
}
```

Route (copy `/api/funnel/remind` guard):

```ts
// apps/web/src/app/api/cron/registrations/route.ts
import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { baseUrl } from "@/lib/oauth";
import { sweepRegistrations } from "@/server/usecases/registrations";

/** POST /api/cron/registrations — hourly: T-24h payment reminders, then expire
 *  overdue card pendings and promote the waitlist. Cron-shaped (x-cron-secret). */
export async function POST(req: Request) {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    if ((await headers()).get("x-cron-secret") !== secret) throw new HttpError(401, "Bad cron secret");
    return sweepRegistrations(baseUrl(req));
  });
}
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(reg): pay-window sweep — reminders, expiry, promotion`

---

### Task 9: Emails — stripe variants + promoted + refund + dispute

**Files:**
- Modify: `apps/web/src/lib/email-templates/registration.ts` (pay-online variant), `payment-reminder.ts` (checkoutUrl + deadline), `index.ts` (exports)
- Create: `apps/web/src/lib/email-templates/registration-promoted.ts`, `refund-issued.ts`, `dispute-alert.ts`
- Modify: `apps/web/src/lib/email.ts` (send fns: `sendRegistrationPromotedEmail`, `sendRefundIssuedEmail`, `sendDisputeAlertEmail`; extend `RegistrationEmail`/reminder args)
- Modify: callers — `submitRegistration` (payOnline args), `withdrawCore`/`refundRegistration` (refund email), Task 8 promoted email, Task 10 dispute email
- Test: `apps/web/src/lib/email-templates/__tests__/` — follow the existing template test file pattern (grep one; assert subject + key strings in html/text)

- [ ] **Step 1: Failing tests** — snapshot-ish assertions per template: stripe confirmation contains "Pay now" + deadline; reminder contains checkout link; promoted contains deadline or instructions; refund contains amount; dispute names competition + amount.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — extend `RegistrationEmailArgs` with `payUrl?: string | null; payDeadline?: Date | string | null`; template branches: `paid && payUrl` → button("Pay now", payUrl) + deadline line instead of instructions panel. `PaymentReminderArgs` += `checkoutUrl?: string | null; payDeadline?: Date | string | null`. New templates follow `registration.ts` structure (`renderEmail`, `panel`, `paragraph`, `money` from `shared.ts`/`compose.ts`). Wire senders in `email.ts` mirroring `sendRegistrationEmail`. Update callers:
  - `submitRegistration`: `payUrl: checkoutUrl, payDeadline: reg.expires_at` for stripe; instructions only for offline.
  - auto/manual refunds + late/duplicate refunds: fire `sendRefundIssuedEmail({ to, amountCents, currency, competitionName, refCode })` `.catch(() => {})`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(reg): payment email suite (pay-now, promoted, refund, dispute)`

---

### Task 10: Dispute + external-refund webhooks

**Files:**
- Modify: `apps/web/src/app/api/webhooks/stripe/route.ts` (cases `charge.dispute.created`, `charge.dispute.closed`, `charge.refunded`)
- Modify: `apps/web/src/server/usecases/registrations.ts` (new `handleRegistrationDispute`, `syncRegistrationRefund`)
- Test: registrations suite (call handlers directly with fake Stripe objects)

**Interfaces:**
- Produces: `handleRegistrationDispute(dispute: Stripe.Dispute, phase: "created" | "closed"): Promise<void>`; `syncRegistrationRefund(charge: Stripe.Charge): Promise<void>`.

- [ ] **Step 1: Failing tests**

```ts
it("dispute.created flags the registration and emails the organiser", async () => {
  await handleRegistrationDispute(fakeDispute({ payment_intent: "pi_1", id: "dp_1", status: "needs_response" }), "created");
  // disputed_at + dispute_id set; audit registration.disputed exists
});
it("dispute lost writes off the payment", async () => { /* closed + status:'lost' → refunded_cents = amount_cents */ });
it("charge.refunded from the Stripe dashboard syncs refunded_cents", async () => { /* amount_refunded mirrors */ });
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement**

```ts
export async function handleRegistrationDispute(dispute: Stripe.Dispute, phase: "created" | "closed"): Promise<void> {
  const intent = typeof dispute.payment_intent === "string" ? dispute.payment_intent : dispute.payment_intent?.id;
  if (!intent) return;
  const [reg] = await sql<RegistrationRow[]>`
    select ${sql(REG_COLS as unknown as string[])} from registrations
    where payment_intent_id = ${intent}`;
  if (!reg) return;
  const ctx = await divisionCtx(sql, reg.division_id);
  if (phase === "created") {
    await sql`update registrations set disputed_at = now(), dispute_id = ${dispute.id}, updated_at = now() where id = ${reg.id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.disputed",
      { registration_id: reg.id, dispute_id: dispute.id, amount_cents: dispute.amount }, null);
    // Organiser alert: owner email lookup (organizations.created_by → users.email).
    const [owner] = await sql<{ email: string }[]>`
      select u.email from organizations o join users u on u.id = o.created_by where o.id = ${reg.org_id}`;
    if (owner) void sendDisputeAlertEmail({ to: owner.email, orgName: ctx.org_name,
      competitionName: ctx.comp_name, displayName: reg.display_name,
      amountCents: dispute.amount, currency: reg.currency ?? "gbp", refCode: reg.ref_code }).catch(() => {});
  } else if (dispute.status === "won") {
    await sql`update registrations set disputed_at = null, updated_at = now() where id = ${reg.id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.dispute_won",
      { registration_id: reg.id, dispute_id: dispute.id }, null);
  } else if (dispute.status === "lost") {
    await sql`update registrations
      set refunded_cents = amount_cents, refunded_at = coalesce(refunded_at, now()), updated_at = now()
      where id = ${reg.id}`;
    await audit(sql, ctx.competition_id, reg.org_id, "registration.dispute_lost",
      { registration_id: reg.id, dispute_id: dispute.id }, null);
  }
}

export async function syncRegistrationRefund(charge: Stripe.Charge): Promise<void> {
  const intent = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id;
  if (!intent) return;
  await sql`
    update registrations
    set refunded_cents = greatest(refunded_cents, ${charge.amount_refunded}),
        refunded_at = coalesce(refunded_at, now()), updated_at = now()
    where payment_intent_id = ${intent}`;
}
```

Webhook route: add three cases calling these (dispute phase from event type). Note: `payment_intent_data.metadata` already tags registration intents, but lookup is by `payment_intent_id` so non-registration charges no-op safely.

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `feat(reg): dispute + external-refund webhook handling`

---

### Task 11: Delete guard — money records block hard delete

**Files:**
- Modify: `apps/web/src/server/usecases/divisions.ts` (`deleteDivision`, after `assertRegistrationClosed`)
- Test: divisions suite (grep existing delete tests file)

- [ ] **Step 1: Failing test** — division in setup with a registration carrying `payment_intent_id` → `deleteDivision` rejects 409 `REGISTRATION_PAYMENTS`; after full refund (`refunded_cents = amount_cents`) delete succeeds.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — after `assertRegistrationClosed(tx, id, "delete")`:

```ts
// Money records must outlive mistakes: block hard delete while any card
// payment on this division is not fully refunded (spec issue #10).
const [{ live_payments }] = await tx<{ live_payments: number }[]>`
  select count(*)::int as live_payments from registrations
  where division_id = ${id} and payment_intent_id is not null
    and refunded_cents < amount_cents`;
if (live_payments > 0) {
  throw new HttpError(
    409,
    "Registrations here hold card payments — refund them before deleting, or archive instead",
    "REGISTRATION_PAYMENTS",
    { archive: true },
  );
}
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `fix(reg): block division delete over unrefunded card payments`

---

### Task 12: Admin — /admin/settings page + org fee override surfacing

**Files:**
- Create: `apps/web/src/app/admin/settings/page.tsx`, `apps/web/src/components/admin-platform-settings.tsx`, `apps/web/src/app/api/admin/settings/route.ts`
- Modify: `apps/web/src/app/admin/layout.tsx` (nav link), `apps/web/src/components/admin-plan-panel.tsx` (labeled fee-override shortcut listing current effective % — reuses the existing `entitlement-override` endpoint with `feature_key: "registration.fee_percent"`)
- Test: route test asserting staff-only + validation (mirror an existing `/api/admin/*` route test; grep `admin` under `__tests__`)

**Interfaces:**
- Consumes: `setPlatformFeeDefault`, `platformFeeDefault` (Task 2); existing admin auth wrapper — copy the guard from `apps/web/src/app/api/admin/orgs/[id]/entitlement-override/route.ts` verbatim.
- Produces: `GET /api/admin/settings` → `{ platform_fee_percent: number }`; `PUT` body `{ platform_fee_percent: number }`.

- [ ] **Step 1: Failing test** — PUT 3 → GET 3; PUT 101 → 422; non-staff 403.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — route calls the Task 2 lib; page is a server component rendering `AdminPlatformSettings` (client) with a numeric input (`step=0.5, min=0, max=100`), Save button, chain explainer copy: "Applies when an org has no per-org override and its plan has no fee row (Pro 2%, Event Pass 5%)." AdminPlanPanel: under the overrides list, show `Entry-fee cut: {effective}%` with a "Set override" shortcut that pre-fills feature_key.
- [ ] **Step 4: Run** — PASS. Manual: `/admin/settings` renders, save works.
- [ ] **Step 5: Commit** — `feat(admin): platform fee default + org fee override surfacing`

---

### Task 13: Console panel — method picker, payment column, new actions, banners

**Files:**
- Modify: `apps/web/src/components/v2/registrations-panel.tsx`
- Modify: `apps/web/src/components/public-site/registration-actions.tsx` (no change expected; verify)
- Test: e2e covers (Task 16); component logic is thin — rely on route/usecase tests

**Interfaces:**
- Consumes: settings response fields from Task 3 (`payment_method`, `payment_instructions`, `org_payment_instructions`, `org_default_payment_method`, `charges_enabled`), registration fields (`payment_method`, `expires_at`, `offline_marked_paid_at`, `disputed_at`), routes `mark-paid`/`waive` (Task 7).

- [ ] **Step 1: Implement settings side**
  - `Settings` interface += the four new fields; on first load of an unsaved row (`updated_at === null`, expose from API or check `enabled===false && fee_cents===0`), preselect `payment_method = org_default_payment_method`.
  - Method picker replaces the purple "collected offline" box — two radio cards:
    - **Pay the organiser** (offline): shows textarea "Payment instructions for this division (leave blank to use your organisation's)" placeholder = `org_payment_instructions ?? "Set organisation-wide instructions in Settings → Payments"`.
    - **Card payment** (stripe): sub-copy "Paid at sign-up · auto-confirmed · 48h pay window". When `!charges_enabled`, disable the radio and render inline link "Connect Stripe in Settings → Payments first". `!paidAllowed` keeps the `PlanBadge`.
  - `save()` posts `payment_method` + `payment_instructions` (trimmed || null).
- [ ] **Step 2: Implement list side**
  - `STATUS_STYLE` += `expired: "bg-zinc-100 text-zinc-500"`.
  - Payment chip after the ref code: fee>0 →
    `disputed_at` → `⚠ disputed` (rose); `refunded_cents>0` → `refunded`; `offline_marked_paid_at` → `paid · cash`; `payment_intent_id && (status paid|confirmed)` → `paid · card`; status pending + stripe → `due · card` + countdown `expires_at` (`in Xh`); pending + offline → `due · cash`; withdrawn + `payment_intent_id && refunded_cents < amount_cents` → `refund incomplete` (amber) — the existing Refund button doubles as retry.
  - Actions: pending + fee>0 + offline-method rows get **Mark paid** (primary ghost, calls `mark-paid`); pending|waitlisted + fee>0 get overflow **Confirm without payment** (calls `waive`, confirm dialog); existing Approve stays for free divisions and paid rows.
  - Banner above the list when `settings.payment_method === "stripe" && !settings.charges_enabled`: "Card payments are offline — registrants can't pay until Stripe is reconnected." Banner when any `disputed_at`: "{n} payment(s) disputed — check your email / Stripe dashboard."
- [ ] **Step 3: Verify visually** — dev server, division with each state (see Task 16 seed script), screenshot desktop + 390px (frontend-design mirror rule).
- [ ] **Step 4: Commit** — `feat(reg): console payment controls — method picker, mark-paid, dispute badges`

---

### Task 14: Public register page + status page modernization

**Files:**
- Modify: `apps/web/src/components/public-site/register-form.tsx`
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/register/status/page.tsx`
- Modify: `apps/web/src/components/public-site/registration-actions.tsx` (enable pay)
- Modify: `apps/web/src/server/usecases/registrations.ts` (`publicRegistrationStatus` view fields)
- Test: extend registrations suite for the view fields; visual via Task 16

**Interfaces:**
- `PublicStatusView` gains `payment_method: string | null`, `expires_at: string | null`, `can_pay_online: boolean` (pending + stripe + fee>0 + charges_enabled), `status: "expired"` copy support; `payment_instructions` resolves `settings.payment_instructions ?? org`.

- [ ] **Step 1: Failing test** — status view for a stripe pending returns `can_pay_online: true`, `expires_at` set, no instructions; offline pending returns instructions override when set.
- [ ] **Step 2: Run** — FAIL. Implement view changes. PASS.
- [ ] **Step 3: Register form** (design pass — courtside `--ps-*` vocab stays):
  - Division card meta line gains a method word: fee>0 → `· pay by card at sign-up` (stripe) / `· pay the organiser` (offline). Fee chip unchanged.
  - `submitLabel` for stripe divisions: `Continue to payment — £X` (msg key `register.submit.card`); offline keeps current fee label; waitlist label unchanged + sub-line under button (offline+waitlist or stripe+waitlist): "Full — join the waitlist, pay only if promoted."
  - Closed_reason `payments_unavailable` card: "Card payments are temporarily unavailable — try again shortly."
  - Add `msg` entries in `apps/web/src/lib/messages.ts` (grep `register.submit.fee` for the block).
- [ ] **Step 4: Status page**
  - `STATUS_COPY` += `expired: { title: "Pay window passed", body: "This registration expired unpaid. If spots remain you can register again.", tone: "border-zinc-200 bg-zinc-50 text-zinc-600" }`; pending copy branches: card → "Complete payment to confirm your spot — your place is held until {deadline}."
  - Countdown chip: server-render `expires_at` via existing `ClientTime` (`tz` prop, memory PROMPT-33) or plain UTC string — deterministic, no hydration mismatch (memory: locale hydration).
  - `RegistrationActions` gets `paymentDue={view.can_pay_online}` (drop the forced false + stale comment); pay button label "Pay entry fee — {amount}".
  - Instructions block only when `payment_method === 'offline'`; timeline strip (Submitted ✓ → Payment {state} → Confirmed {state}) as a simple 3-dot flex row above the ticket.
- [ ] **Step 5: Verify visually** (screenshots both pages, desktop + mobile) + commit — `feat(reg): public register/status payment UX`

---

### Task 15: Org settings payments card + org PATCH

**Files:**
- Modify: `apps/web/src/app/o/[orgSlug]/settings/page.tsx` (payments section)
- Modify: `apps/web/src/components/org-payment-instructions.tsx` → grow into method default + instructions (same file)
- Modify: `apps/web/src/app/api/orgs/[id]/route.ts` (+ its zod body: accept `default_payment_method`)
- Test: org route test (grep existing PATCH test) — accepts `default_payment_method: "stripe"`, rejects `"card"`.

- [ ] **Step 1: Failing route test** → run FAIL → implement:
  - PATCH schema += `default_payment_method: z.enum(["offline","stripe"]).optional()`; update SQL set-list.
  - Settings card: radio pair "How do entry fees usually work?" (offline default / card) writing via the same PATCH; Connect status line (uses existing connect status endpoint used on billing page — grep `connectStatus` client usage; if only server-side, render server-fetched status prop) + "Connect / resume onboarding" link to the existing Connect start route; keep instructions textarea below with sub-copy "Divisions can override these instructions."
- [ ] **Step 2: Run** — PASS; visual check; commit — `feat(reg): org default payment method + payments card`

---

### Task 16: e2e + smoke + seed

**Files:**
- Modify: existing registration e2e spec (grep `register` under `e2e/` or `apps/web/e2e`) + add `e2e/registration-payments.spec.ts`
- Modify: `scripts/smoke.ts`
- Test: this IS the test task

- [ ] **Step 1: e2e offline journey** — seed org+division (offline, fee 1500, capacity 2, instructions override): public register → status page shows override instructions + ticket; organiser panel → Mark paid → status flips confirmed; entrant appears. Withdraw → waitlist promotion asserted. Run per memory `project_test_infra` conventions (`next dev -p 3013` + PLAYWRIGHT_BASE if :3000 squatted).
- [ ] **Step 2: e2e stripe-path UI (no live Stripe)** — division with method stripe but org `charges_enabled=false` via SQL: register page shows `payments_unavailable` card; flip `charges_enabled=true` + submit intercepting `/register` response asserting `checkout_url` non-null (mock `getStripe` not possible in e2e — instead point env `STRIPE_SECRET_KEY` at test key if present, else `test.skip` with reason). Keep deterministic: default CI path = skip when no key.
- [ ] **Step 3: smoke.ts** — pro path: create stripe-method division (charges flag flipped by SQL like e2e), submit, assert checkout_url; free path: offline division, submit, mark paid, confirm. Extend per memory `feedback_smoke_demo`.
- [ ] **Step 4: Run all** — `npx vitest run` (unit+DB), e2e spec, `npx tsc --noEmit`, lint. All green.
- [ ] **Step 5: Commit** — `test(reg): e2e + smoke coverage for dual payments`

---

### Task 17: Docs + deploy checklist + memory

- [ ] README/help: update `apps/web/src/server/help-content.ts` registration article (grep "registration") for the two methods + pay window.
- [ ] Deploy checklist (PR body): run V273 (`db:apply`), set `CRON_SECRET` + hourly scheduler for `/api/cron/registrations`, confirm `STRIPE_WEBHOOK_SECRET` covers `charge.dispute.*` + `charge.refunded` events in the Stripe dashboard endpoint config, optional `PLATFORM_FEE_PERCENT` now only a fallback.
- [ ] Memory file: project note w/ decisions + gotchas discovered during implementation.
- [ ] Final: full `npx vitest run` + `npx tsc --noEmit` + e2e; push branch; PR with issue-matrix table in body.

## Self-review (done at write time)

- Spec coverage: §1→T1, fee chain→T2, §3 settings/validation→T3, submit/checkout→T4, hardening #1/#2→T5, token-free return→T6, #7 mark-paid/waive→T7, §2 promotion+§6 sweep→T8, §7 emails→T9, #5 disputes + refund sync→T10, #10 delete guard→T11, §5 admin→T12, §8 console→T13, §8 public→T14, org card→T15, §9 tests→T16, checklist→T17. Issue #13 min-charge→T3; #8 snapshot→T4/T8.
- Type consistency: `createRegistrationCheckout(reg, ctx, origin, token)` used in T4/T8; `promoteOldestWaitlisted(tx, divisionId, settings)` in T8; `sweepRegistrations(origin)` route T8; settings fields consistent T3→T13/T14/T15.
- No placeholders: UI tasks specify exact fields, states, copy; code tasks carry code.
