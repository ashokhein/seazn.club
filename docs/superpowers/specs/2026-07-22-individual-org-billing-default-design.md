# Individual-per-org billing by default; sharing a bill becomes opt-in

**Issue:** #212 · **Branch:** `feat/individual-org-billing-default` (off `main`)
**Date:** 2026-07-22 · **Status:** design approved, ready for plan

## Problem

Since billing groups (V314), `createOrgForUser` auto-joins a user's **second**
org onto their **first** org's subscription — one shared bill, priced by count.
Before billing groups every org got its own subscription. The auto-join is
silent and surprises users who expected individual billing.

`apps/web/src/lib/auth.ts` `createOrgForUser`:

```ts
const ownedGroups = await groupIdsOwnedBy(userId);
const targetGroupId = ownedGroups.length === 1 ? ownedGroups[0] : null; // join iff exactly one group
```

| Groups owned | New org | Billing (today) |
| --- | --- | --- |
| 0 | own group | individual |
| **1** | **joins it** | **shared (surprise)** |
| 2+ | own group | individual |

## Goal

1. **Default:** every new org gets its **own** community group (individual
   billing). Drop the auto-join.
2. **Opt-in to share:** a choice at org creation — "Bill this separately"
   (default) vs "Add to an existing bill ▾" picking one of the creator's
   eligible groups.
3. Sharing can **also** be changed later, both ways, from the existing billing
   panel (attach to combine, detach to separate). No change needed there — this
   spec only documents that it stays true.
4. The half-price-extra-org discount is preserved **when** orgs share — only the
   trigger becomes opt-in, never automatic.
5. Caps (`orgs.max_owned`) still enforced.
6. Existing shared groups untouched (no migration).

## Why dropping the auto-join is cap-safe (the load-bearing fact)

The `createOrgForUser` comment claims the auto-join "is what makes the community
cap bite — if every new org got its own group of one, a per-group cap would
never be exceeded and a free user could create orgs for ever." **This fear is
already handled elsewhere.** `assertMayOwnAnotherOrg` (`auth.ts`) caps the
total orgs a *user* owns, independently of grouping:

```ts
const owned = /* all orgs where role='owner' */;
if (owned.length === 0) return;
const limit = Math.max(...limits);        // best owned-org plan's orgs.max_owned
if (owned.length + 1 > limit) throw new PaymentRequiredError("orgs.max_owned");
```

A community user (`orgs.max_owned = 1`) still cannot create a second org — the
per-*user* check refuses it, whether or not a group is involved. The per-group
cap (`assertWithinGroupCap`) is a second, narrower gate that still applies on
the explicit attach path. Both remain. Dropping the auto-join removes nothing
that protects caps.

## Design

### 1. Backend — `createOrgForUser` → always individual (simplify)

Remove the auto-join entirely. No `groupIdsOwnedBy`, no `targetGroupId`, no
`capLimit`, no in-transaction group-join branch, no post-create
`syncGroupQuantity`. Always mint a fresh community group (the existing
`if (!groupId)` insert becomes unconditional). Keep `assertMayOwnAnotherOrg`.

Signature unchanged: `createOrgForUser(userId, name)`. This is a net reduction
in moving parts — the money-movement lives in exactly one place (`attach`).

### 2. Route — `POST /api/orgs` gains optional `attachToGroupId`

- `createOrgSchema` (`lib/types.ts`) += `attachToGroupId: z.string().uuid().optional()`.
- Flow in `apps/web/src/app/api/orgs/route.ts`:
  1. `org = await createOrgForUser(user.id, name)` — always individual.
  2. `await setActiveOrgId(org.id)`.
  3. If `attachToGroupId`: `await attachOrgToGroup({ actorUserId: user.id, orgId: org.id, subscriptionId: attachToGroupId })`.
- Response shape: `{ ...org, attach?: { ok: boolean; charged?: boolean; reason?: string } }`.
  - Attach success → `{ ok: true, charged }`.
  - Attach throws (Stripe down, declined, raced-ineligible) → **the org already
    exists standalone** (the safe default). Catch, return `{ ok: false, reason }`
    with HTTP 200. The org is created; the UI explains it stayed on its own bill.

**This reuses `attachOrgToGroup` — zero new Stripe/charge/cap code.** That
usecase already: owner-gates both org and group, refuses `past_due` /
`cancel_at_period_end` / non-active groups, refuses an org that still has its own
live subscription (N/A for a brand-new org), enforces the group cap under a row
lock, is idempotent, and prorates the charge. A freshly-created org (community
group, no live sub) is exactly its precondition.

### 3. Picker data

- **Eligible groups:** extend / reuse `GET /api/billing/groups`. The picker
  needs, per group the user **owns**: `subscription_id`, a display label
  (plan + "N/cap orgs" + payer), an `eligible` flag with a `reason` when not,
  and the per-extra price hint. Eligibility mirrors `attachOrgToGroup`'s gates:
  plan is Pro/Pro Plus (community holds 1 → always full), status active/trialing,
  not `past_due`, not `cancel_at_period_end`, `activeOrgCount < cap`.
- **Exact charge:** on selecting a paid group, call the existing
  `POST /api/billing/group/attach/preview` (backed by `previewAttachCharge`) to
  show "£X.XX now, then +£9/mo". A null preview (free move / re-add) → no charge
  line.

### 4. UI — `create-org-form.tsx` (frontend-design skill)

Current form is a bare card with one name input. Redesign:

- **Billing choice** (radio group), only rendered when the user owns ≥1
  eligible group; otherwise the form stays name-only:
  - ● **Bill this separately** (default) — "Its own plan and invoice."
  - ○ **Add to an existing bill ▾** — picker of eligible groups.
- Ineligible owned groups appear **disabled with the reason** ("Full", "Payment
  overdue", "Scheduled to cancel", "Community holds one org").
- On selecting a paid group, fetch the preview; the submit button becomes
  **"Create & add — £X.XX now"** (with a "then +£9/mo" sub-line). Separate →
  **"Create organisation"**.
- Post-submit: on `attach.ok === false`, show a non-blocking notice — "Created
  on its own bill. Couldn't add it to <group>: <reason>." — and route to the
  dashboard as today.
- Apply the frontend-design skill: build variants, screenshot, and (per the
  visual-approval convention) get user sign-off on the look before merge.

### 5. Help + copy — `apps/web/content/help/billing/groups.md`

Add near the top of "Adding an organisation":

- A new organisation starts on its **own** bill (its own plan and invoice) by
  default.
- You can add it to an existing bill **at creation** (the choice on the create
  form) **or later** from Settings → Billing → Billing group.
- You can **leave** a bill later too (detach → back to its own bill).

Adjust any wording that implies a new org joins a bill automatically. The rest
of the page (attach/detach/transfer semantics) is unchanged and stays correct.

## Test plan (TDD — failing-first)

### Unit
- **Regression (the failing-without-it test):** a user who owns **exactly one**
  group creates a second org → the new org lands in its **own** new community
  group, and the first group's org count is unchanged. Today this joins; the
  test fails until the auto-join is dropped.
- Update the existing tests that assumed the auto-join:
  - `lib/__tests__/billing-groups.test.ts` (~226–237: "createOrgForUser only
    consults the group cap when the user owns EXACTLY one").
  - `server/usecases/__tests__/billing-group-move.test.ts` (~591, ~1274–1282,
    ~1605–1616: "createOrgForUser puts the org into the creator's existing
    group" / the concurrent-create race). These now assert individual groups.
- **Route:** `POST /api/orgs` with `attachToGroupId` on an eligible Pro group →
  the org lands in that group and `attach.charged === true` (Stripe mocked).
- **Route:** `attachToGroupId` on an ineligible group (past_due / full) → the
  org is still created standalone and `attach.ok === false` with a reason.
- **Schema:** `attachToGroupId` accepted when a valid uuid, rejected otherwise;
  absent = individual (back-compat).

### e2e — `billing-groups-journey.spec.ts` (+ panel spec)
- **Separate (new default):** create a 2nd org via "Bill this separately" →
  two separate bills; the first org's bill is unchanged.
- **Share at creation:** create a 2nd org via "Add to an existing bill" → the
  group's bill goes up by the half-price extra; one invoice covers both.
- **Change later:** detach a shared org → its own bill; re-attach → back onto
  the group. (Confirms both directions remain reachable post-creation.)

### Edge cases (out of the box)
- User owns **0** groups → no picker rendered; form is name-only.
- User owns **2+** groups → all eligible listed; default still "separate".
- **Community group never eligible** — it holds exactly 1 org, so it is always
  at cap; it must not appear as an attach target.
- Target **past_due / cancel_at_period_end / full** → shown disabled with reason;
  server also refuses (defence in depth via `attachOrgToGroup`).
- **Attach fails after create** (Stripe unreachable / card declined) → org exists
  standalone; UI surfaces the reason; no half-charged state (`attachOrgToGroup`
  is atomic and idempotent).
- **Race:** two concurrent creates, or a create+attach racing a detach — covered
  by `attachOrgToGroup`'s org-then-group lock ordering.
- Callers that must stay individual: `funnel.ts` (`createOrgForUser`) and the
  signup/invite paths pass no group → individual, which is the desired fix.

## Back-compat / migration

None. No schema change. Existing shared groups are untouched. The behaviour
change is confined to *new* org creation, and the only observable difference is
that a second org no longer silently joins the first.

## Verify

```
cd apps/web && npx tsc --noEmit && npx vitest run
# then: npx playwright test billing-groups-journey.spec.ts (local prod build, E2E_PROD_TARGET)
```

## Out of scope

- Splitting a single invoice between payers (a payments product, not a setting).
- Bulk "move all my orgs onto one bill" — the panel's per-org attach covers it.
- Any change to detach/transfer/quantity-sync semantics.
