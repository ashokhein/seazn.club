# Individual-per-org Billing Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every newly-created org start on its **own** community billing group (individual billing); let a user opt in to sharing a bill via a choice on the create-org form that routes through the existing `attachOrgToGroup`.

**Architecture:** Drop the auto-join in `createOrgForUser` so it always mints a fresh community group. Add an optional `attachToGroupId` to `POST /api/orgs`; when present the route creates the org individually then calls the existing `attachOrgToGroup` usecase (which owns every Stripe/cap/eligibility rule). The create-org form gains a billing choice; ineligibility and the exact prorated charge are computed from the already-published `GET /api/billing/groups` and `POST /api/billing/group/attach/preview`.

**Tech Stack:** Next.js (this repo's forked build — read `node_modules/next/dist/docs/` before touching routing), TypeScript, postgres.js, Zod, Vitest, Playwright, React client components, flat-key i18n (en/es/fr/nl).

## Global Constraints

- Branch `feat/individual-org-billing-default` off `main`; worktree already created.
- No DB migration. Existing shared groups must be untouched.
- Reuse `attachOrgToGroup` — do NOT re-implement any Stripe/charge/cap logic.
- `assertMayOwnAnotherOrg` stays the per-user cap; do not weaken it.
- Every change ships a failing-without-it test (repo convention).
- i18n: new copy goes in all four `dictionaries/{en,es,fr,nl}/ui.json` as flat dotted keys; run `npm run i18n:gen-keys` and `npm run i18n:check` after.
- UI work uses the frontend-design skill and gets visual sign-off before merge (visual-approval convention).
- Verify command: `cd apps/web && npx tsc --noEmit && npx vitest run`.

---

### Task 1: `createOrgForUser` always individual (drop the auto-join)

**Files:**
- Modify: `apps/web/src/lib/auth.ts` — `createOrgForUser` (the join decision + in-tx branch + post-create sync).
- Test: `apps/web/src/lib/__tests__/billing-groups.test.ts` (add regression; update the "exactly one group" cases ~226–237).
- Test: `apps/web/src/server/usecases/__tests__/billing-group-move.test.ts` (update the "joins existing group" cases ~591, ~1274–1282; the concurrent-create race ~1605–1616 now expects two groups).

**Interfaces:**
- Consumes: nothing new.
- Produces: `createOrgForUser(userId: string, name: string): Promise<Organization>` — unchanged signature, new guarantee: the returned org is always on a **new** community group of its own.

- [ ] **Step 1: Write the failing regression test**

Add to `apps/web/src/lib/__tests__/billing-groups.test.ts` (DB-backed; skipped without `DATABASE_URL`, matching the file):

```ts
it("a second org does NOT join the first — each gets its own group", async () => {
  const { createOrgForUser } = await import("@/lib/auth");
  const s = uniq();
  // Seed a user who owns exactly one PRO group with one org, so the OLD code
  // would auto-join the second org onto it.
  const [{ id: userId }] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`indiv-${s}@test.local`}, 'Indiv', true) returning id`;
  const first = await createOrgForUser(userId, `First ${s}`);
  // Lift the per-user cap so creation is allowed (community caps at 1 org).
  await sql`update subscriptions set plan_key = 'pro'
             where id = (select subscription_id from organizations where id = ${first.id})`;

  const second = await createOrgForUser(userId, `Second ${s}`);

  const [f] = await sql<{ subscription_id: string }[]>`
    select subscription_id from organizations where id = ${first.id}`;
  const [g] = await sql<{ subscription_id: string }[]>`
    select subscription_id from organizations where id = ${second.id}`;
  expect(g.subscription_id).not.toBe(f.subscription_id); // its OWN group
  const [cnt] = await sql<{ n: string }[]>`
    select count(*)::text as n from organizations
     where subscription_id = ${f.subscription_id} and deleted_at is null`;
  expect(cnt.n).toBe("1"); // first group unchanged
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/lib/__tests__/billing-groups.test.ts -t "does NOT join"`
Expected: FAIL — `g.subscription_id` equals `f.subscription_id` (the org joined the first group).

- [ ] **Step 3: Simplify `createOrgForUser` to always-individual**

In `apps/web/src/lib/auth.ts`, replace the body from the `groupIdsOwnedBy` line through the end of the function. Delete: the `ownedGroups`/`targetGroupId`/`capLimit` resolution, the in-transaction `if (groupId) { lock+count+assertWithinGroupCap }` branch, and the trailing `if (targetGroupId) { syncGroupQuantity }` block. The transaction becomes:

```ts
export async function createOrgForUser(userId: string, name: string): Promise<Organization> {
  await assertMayOwnAnotherOrg(userId);
  // Individual by default (#212): every new org mints its OWN community group.
  // Sharing a bill is opt-in — either the create-org form's billing choice
  // (which routes through attachOrgToGroup) or the billing panel's attach.
  // The per-user cap above is what stops a free user minting orgs for ever;
  // the per-GROUP cap is enforced on the explicit attach path.
  let org: Organization | undefined;
  for (let attempt = 0; ; attempt++) {
    const base = await generateOrgSlug(name);
    const slug = attempt < 2 ? base : `${base}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      org = await sql.begin(async (tx) => {
        const [s] = await tx<{ id: string }[]>`
          insert into subscriptions (owner_user_id, plan_key, status, quantity_paid)
          values (${userId}, 'community', 'active', 1)
          returning id`;
        const [o] = await tx<Organization[]>`
          insert into organizations (name, slug, created_by, subscription_id)
          values (${name}, ${slug}, ${userId}, ${s.id})
          returning id, name, slug, created_by, created_at, logo_url, logo_storage_path, payment_instructions, default_payment_method, branding, timezone`;
        await tx`
          insert into org_members (org_id, user_id, role)
          values (${o.id}, ${userId}, 'owner')`;
        return o;
      });
      break;
    } catch (err) {
      const unique =
        typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
      if (!unique || attempt >= 4) throw err;
    }
  }
  await invalidateUserOrgs(userId);
  return org;
}
```

Remove the now-unused import of `groupOrgLimit` from this file **only if no other function here uses it** (grep first: `grep -n "groupOrgLimit\|groupIdsOwnedBy" apps/web/src/lib/auth.ts`). `assertWithinGroupCap` likewise.

- [ ] **Step 4: Run the regression test, verify it passes**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/lib/__tests__/billing-groups.test.ts -t "does NOT join"`
Expected: PASS.

- [ ] **Step 5: Update the tests that asserted the auto-join**

In `billing-groups.test.ts` (~226–237) the "createOrgForUser only consults the group cap when the user owns EXACTLY one group" case: the second org now lands in its own group. Rewrite its assertion to expect a **new** group (and that `assertMayOwnAnotherOrg` still refuses past the per-user cap — the `rejects.toBeInstanceOf(PaymentRequiredError)` part stays, driven by the plan's `orgs.max_owned`, not by the group).

In `billing-group-move.test.ts`: the `createOrgForUser(payer, "Second …")` at ~1274–1282 that expected the org in the payer's existing group now expects a distinct group. The concurrent-create race at ~1605–1616 previously expected both into one group under the lock; it now expects **two** groups (no shared lock target) — assert both orgs exist and each has a distinct `subscription_id`, and `assertMayOwnAnotherOrg` bounded the total.

- [ ] **Step 6: Run the full billing suites**

Run: `cd apps/web && DATABASE_URL=$TEST_DATABASE_URL npx vitest run src/lib/__tests__/billing-groups.test.ts src/server/usecases/__tests__/billing-group-move.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/auth.ts apps/web/src/lib/__tests__/billing-groups.test.ts apps/web/src/server/usecases/__tests__/billing-group-move.test.ts
git commit -m "feat(billing): new orgs start on their own bill (drop auto-join) (#212)"
```

---

### Task 2: `POST /api/orgs` — optional `attachToGroupId` (create-then-attach)

**Files:**
- Modify: `apps/web/src/lib/types.ts` — `createOrgSchema` (~line 109).
- Modify: `apps/web/src/app/api/orgs/route.ts` — `POST`.
- Test: `apps/web/src/app/api/orgs/__tests__/route.test.ts` (create).

**Interfaces:**
- Consumes: `attachOrgToGroup({ actorUserId, orgId, subscriptionId }): Promise<{ subscription_id: string; quantity: number; charged: boolean }>` from `@/server/usecases/billing-groups`.
- Produces: `POST /api/orgs` accepts `{ name: string; attachToGroupId?: string }` and returns the org object plus `attach?: { ok: boolean; charged?: boolean; reason?: string }`.

- [ ] **Step 1: Write the failing route tests**

Create `apps/web/src/app/api/orgs/__tests__/route.test.ts`. Mock auth + the attach usecase so this is a pure route test (attach's DB/Stripe behaviour is covered elsewhere):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
  createOrgForUser: vi.fn(async (_u: string, name: string) => ({ id: "org-9", name, slug: "s" })),
  setActiveOrgId: vi.fn(async () => {}),
  getUserOrgs: vi.fn(async () => []),
}));
const attachOrgToGroup = vi.fn();
vi.mock("@/server/usecases/billing-groups", () => ({ attachOrgToGroup: (...a: unknown[]) => attachOrgToGroup(...a) }));

const post = async (body: unknown) => {
  const { POST } = await import("../route");
  const res = await POST(new Request("http://t/api/orgs", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as { data?: any; error?: unknown } };
};

beforeEach(() => { attachOrgToGroup.mockReset(); });

it("no attachToGroupId → org created individual, attach never called", async () => {
  const r = await post({ name: "Solo" });
  expect(r.status).toBe(200);
  expect(attachOrgToGroup).not.toHaveBeenCalled();
  expect(r.json.data.attach).toBeUndefined();
});

it("eligible attachToGroupId → attach called, charged surfaced", async () => {
  attachOrgToGroup.mockResolvedValue({ subscription_id: "grp-1", quantity: 2, charged: true });
  const r = await post({ name: "Joiner", attachToGroupId: "11111111-1111-1111-1111-111111111111" });
  expect(attachOrgToGroup).toHaveBeenCalledWith({
    actorUserId: "user-1", orgId: "org-9", subscriptionId: "11111111-1111-1111-1111-111111111111",
  });
  expect(r.json.data.attach).toEqual({ ok: true, charged: true });
});

it("attach failure → org still created standalone, reason surfaced (200)", async () => {
  const { HttpError } = await import("@/lib/errors");
  attachOrgToGroup.mockRejectedValue(new HttpError(409, "This billing group has an unpaid invoice. Settle it before adding another organisation."));
  const r = await post({ name: "Joiner", attachToGroupId: "11111111-1111-1111-1111-111111111111" });
  expect(r.status).toBe(200);
  expect(r.json.data.id).toBe("org-9");
  expect(r.json.data.attach).toEqual({ ok: false, reason: "This billing group has an unpaid invoice. Settle it before adding another organisation." });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `cd apps/web && npx vitest run src/app/api/orgs/__tests__/route.test.ts`
Expected: FAIL — schema rejects `attachToGroupId` (`.strict()`) / route ignores it.

- [ ] **Step 3: Extend the schema**

In `apps/web/src/lib/types.ts`:

```ts
export const createOrgSchema = z.object({
  name: z.string().min(1).max(60),
  /** Opt in to sharing a bill at creation (#212): attach the new org onto this
   *  billing group the actor pays for. Absent = its own bill (the default). */
  attachToGroupId: z.string().uuid().optional(),
}).strict();
```

- [ ] **Step 4: Implement the route**

Replace `POST` in `apps/web/src/app/api/orgs/route.ts`:

```ts
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { name, attachToGroupId } = createOrgSchema.parse(await req.json());
    const org = await createOrgForUser(user.id, name);
    await setActiveOrgId(org.id);
    if (!attachToGroupId) return org;
    try {
      const { attachOrgToGroup } = await import("@/server/usecases/billing-groups");
      const res = await attachOrgToGroup({ actorUserId: user.id, orgId: org.id, subscriptionId: attachToGroupId });
      return { ...org, attach: { ok: true, charged: res.charged } };
    } catch (err) {
      // The org already exists on its own bill — the new default. Surface why
      // it did not join rather than failing the whole creation.
      const reason = err instanceof Error ? err.message : "Could not add it to that bill.";
      console.error(`[billing] create-org attach to ${attachToGroupId} failed for org ${org.id}`, err);
      return { ...org, attach: { ok: false, reason } };
    }
  });
}
```

Add the dynamic import note: keeping the Stripe-touching usecase out of the module's static graph matches `createOrgForUser`'s own pattern.

- [ ] **Step 5: Run the route tests, verify they pass**

Run: `cd apps/web && npx vitest run src/app/api/orgs/__tests__/route.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/app/api/orgs/route.ts apps/web/src/app/api/orgs/__tests__/route.test.ts
git commit -m "feat(billing): POST /api/orgs accepts attachToGroupId, create-then-attach (#212)"
```

---

### Task 3: Create-org form — billing choice + picker (frontend-design)

**Files:**
- Modify: `apps/web/src/components/create-org-form.tsx`.
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`.
- Test: `apps/web/src/components/__tests__/create-org-form.test.tsx` (create).

**Interfaces:**
- Consumes: `GET /api/billing/groups` → `Array<{ id, plan_key, status, cancel_at_period_end, has_live_subscription, max_orgs: number|null, orgs: {id}[] }>`; `POST /api/billing/group/attach/preview` `{ subscription_id }` → `{ preview: { amount_minor, currency } | null }`; `POST /api/orgs` `{ name, attachToGroupId? }`.
- Produces: no exported interface change; `CreateOrgForm` renders a billing choice when the user owns ≥1 eligible group.

**Eligibility rule (client-side, mirrors `attachOrgToGroup`'s gates):**
```ts
function eligibility(g): { eligible: boolean; reason?: string } {
  if (g.status === "past_due") return { eligible: false, reason: msg("orgNew.bill.reasonPastDue") };
  if (g.cancel_at_period_end) return { eligible: false, reason: msg("orgNew.bill.reasonCancelling") };
  if (g.status !== "active" && g.status !== "trialing") return { eligible: false, reason: msg("orgNew.bill.reasonInactive") };
  if (g.max_orgs !== null && g.orgs.length >= g.max_orgs) return { eligible: false, reason: msg("orgNew.bill.reasonFull") };
  return { eligible: true };
}
```
(A community group has `max_orgs === 1` and one org → `reasonFull`, so it never offers itself. Correct.)

- [ ] **Step 1: Add the i18n keys (en), then propagate**

Add to `apps/web/src/dictionaries/en/ui.json` next to the existing `orgNew.*` block:

```json
"orgNew.bill.legend": "Billing",
"orgNew.bill.separate": "Bill this separately",
"orgNew.bill.separateHint": "Its own plan and invoice.",
"orgNew.bill.addToExisting": "Add to an existing bill",
"orgNew.bill.addToExistingHint": "Every extra organisation is half price on the same card and invoice.",
"orgNew.bill.pickLabel": "Which bill?",
"orgNew.bill.reasonPastDue": "Payment overdue",
"orgNew.bill.reasonCancelling": "Scheduled to cancel",
"orgNew.bill.reasonInactive": "Not active",
"orgNew.bill.reasonFull": "Full",
"orgNew.bill.chargeNow": "{amount} now",
"orgNew.bill.thenPerExtra": "then billed on the group’s plan",
"orgNew.createAndAdd": "Create & add — {amount} now",
"orgNew.createAndAddFree": "Create & add to this bill",
"orgNew.attachFailed": "Created on its own bill. Couldn’t add it to that bill: {reason}"
```

Then either run `npm --prefix apps/web run i18n:translate` (machine-fills es/fr/nl) or hand-add the same keys to `es/ui.json`, `fr/ui.json`, `nl/ui.json`. Run `npm --prefix apps/web run i18n:gen-keys && npm --prefix apps/web run i18n:check` and confirm parity passes (watch the plural-rule gotcha noted in `project_i18n_payload.md`).

- [ ] **Step 2: Write the failing component test**

Create `apps/web/src/components/__tests__/create-org-form.test.tsx` (mirror an existing `*.test.tsx` for the render harness + DictProvider wrapper):

```tsx
// Mocks: /api/billing/groups returns one eligible Pro group + one full one.
// Assert:
//  - the "Add to an existing bill" radio renders (eligible group present);
//  - the full group is present but disabled with "Full";
//  - choosing the eligible group fetches the preview and the submit button
//    reads "Create & add — $9.00 now";
//  - "Bill this separately" is selected by default and the button reads
//    "Create organisation".
```

Write the concrete assertions against the eligibility + preview wiring (use `vi.stubGlobal("fetch", …)` returning the two payloads; assert button text via `getByRole("button")`).

- [ ] **Step 3: Run it, verify it fails**

Run: `cd apps/web && npx vitest run src/components/__tests__/create-org-form.test.tsx`
Expected: FAIL — the form has no billing choice yet.

- [ ] **Step 4: Implement the form (frontend-design pass)**

Rewrite `create-org-form.tsx`:
- On mount, `fetch("/api/billing/groups")`; keep only groups where the actor is payer (the endpoint already returns only those). Compute `eligibility(g)`.
- Render the billing `<fieldset>` **only if at least one group exists** (eligible or not — a disabled "Full" row is informative); if the user owns zero groups, keep the name-only form.
- Radio A "Bill this separately" (default, `value="separate"`); Radio B "Add to an existing bill" enabling a `<select>` of groups (eligible selectable; ineligible `disabled` with `— {reason}` suffix).
- On selecting a paid, eligible group, `POST /api/billing/group/attach/preview` with its `subscription_id`; store `{ amount_minor, currency }`; format with the repo's `formatMinor`/`asCurrency` helpers (same as `billing-group-panel.tsx`).
- Submit button label: separate → `orgNew.create`; add + priced preview → `orgNew.createAndAdd` with the formatted amount; add + null preview (free move) → `orgNew.createAndAddFree`.
- Submit posts `{ name, attachToGroupId? }`. On response `data.attach?.ok === false`, show `orgNew.attachFailed` with the reason (non-blocking) before routing to `/dashboard`.
- Apply the frontend-design skill to the whole surface (the current bare card): typography, the radio/pill treatment for the choice, the priced button state. Build 2 variants, screenshot both, get user sign-off before merge.

- [ ] **Step 5: Run the component test, verify it passes**

Run: `cd apps/web && npx vitest run src/components/__tests__/create-org-form.test.tsx`
Expected: PASS.

- [ ] **Step 6: Screenshot both variants for sign-off**

Use the Playwright MCP against the dev server’s `/orgs/new` for a payer who owns one eligible group; capture the "separate" and "add to existing (priced)" states. Post for visual approval; do not merge the visual until approved.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/create-org-form.tsx apps/web/src/components/__tests__/create-org-form.test.tsx apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts
git commit -m "feat(billing): create-org form billing choice + eligible-bill picker (#212)"
```

---

### Task 4: Help copy — new orgs bill separately by default

**Files:**
- Modify: `apps/web/content/help/billing/groups.md`.

- [ ] **Step 1: Edit the "Adding an organisation" section**

At the top of `## Adding an organisation`, prepend:

```markdown
A new organisation starts on its **own** bill — its own plan and invoice. You
choose to share a bill deliberately, never automatically: either when you
create the organisation (pick "Add to an existing bill") or later from
**Settings → Billing → Billing group**. You can also **leave** a bill later
and go back to your own — see [Leaving a group](#leaving-a-group).
```

Scan the rest of the page for any wording implying a new org joins a bill automatically and adjust it to the opt-in framing. The attach/detach/transfer mechanics elsewhere are unchanged.

- [ ] **Step 2: Verify the help route renders**

Run the dev server, open `/help/billing/groups`, confirm the new paragraph renders and the `#leaving-a-group` anchor resolves.

- [ ] **Step 3: Commit**

```bash
git add apps/web/content/help/billing/groups.md
git commit -m "docs(help): new orgs bill separately by default; sharing is opt-in (#212)"
```

---

### Task 5: e2e — the journey now proves individual-by-default + opt-in

**Files:**
- Modify: `apps/web/e2e/billing-groups-journey.spec.ts`.

- [ ] **Step 1: Update the journey**

The spec currently walks a journey that assumes the second org auto-joins. Change it to assert three things (scope each assertion to a container per the `feedback_ui_text_breaks_e2e` gotcha — grep the copy across both e2e phases before renaming any label):
1. **Separate (default):** create a second org via "Bill this separately"; assert two separate bills and the first org's bill unchanged.
2. **Share at creation:** create a third org via "Add to an existing bill" onto the paid group; assert the group's seat count / bill rose and one invoice covers both.
3. **Change later:** detach the shared org (panel "Remove from this bill"); assert its own bill; re-attach; assert back on the group.

- [ ] **Step 2: Run the e2e locally (prod build)**

Follow `project_local_e2e_recipe.md`: build prod, run with `E2E_PROD_TARGET` on :3100.
Run: `npx playwright test billing-groups-journey.spec.ts`
Expected: PASS. (Never enable `e2e.yml` — verify locally per `feedback_e2e_workflow_disabled.md`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/e2e/billing-groups-journey.spec.ts
git commit -m "test(e2e): individual-by-default + opt-in share journey (#212)"
```

---

## Self-Review

- **Spec coverage:** default individual (Task 1) ✓; opt-in at creation (Tasks 2–3) ✓; discount preserved via attach (Task 2) ✓; caps via `assertMayOwnAnotherOrg` kept + group cap on attach ✓; help update (Task 4) ✓; e2e + panel journey (Task 5) ✓; no migration / back-compat ✓; change-later documented (Tasks 4–5) ✓.
- **Placeholder scan:** the component test body (Task 3 Step 2) is described, not fully coded — the implementer writes concrete assertions against the stated wiring; acceptable because the exact RTL harness (DictProvider wrapper) must match a sibling test in the repo. All backend steps carry full code.
- **Type consistency:** `attachOrgToGroup({ actorUserId, orgId, subscriptionId })` and its `{ subscription_id, quantity, charged }` return are used verbatim in Tasks 2–3; `attach: { ok, charged?, reason? }` is the single response shape across route, tests, and form.

## Execution Handoff

Recommend **subagent-driven** for Tasks 1–2 (backend, tight tests) and **inline** for Task 3 (frontend-design needs the screenshot/sign-off loop in-session).
