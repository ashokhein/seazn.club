# Registration Console Redesign Implementation Plan (design/v7 PROMPT-52)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline — user forbade subagents) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the organiser registration console as pulse strip + status tabs + settings accordion, expose waitlist count/position publicly, and split withdraw-vs-refund into unmistakable SPOT/MONEY action clusters — semantics frozen.

**Architecture:** All organiser-side numbers (pulse rollup, queue positions, duplicate hints) derive client-side in a pure lib from the full row set `RegistrationsPanel` already fetches — the v1 list API shape does not change, so external API consumers are untouched. Only two public reads change server-side (additive fields): `PublicDivisionInfo.waitlisted` and `PublicStatusView.position`. The 763-line panel becomes a composition shell over four focused components.

**Tech Stack:** Next.js 16 App Router, React client components, vitest (pure + real-Postgres suites), Playwright e2e, Tailwind with existing `.card`/v3 UI conventions.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-13-reg-console-redesign-design.md`; normative semantics: `2026-07-12-registration-payments-design.md` §2 + §4.
- PR #72's suite `src/server/usecases/__tests__/registrations.test.ts` passes **unmodified** — never edit it; any needed edit means behavior moved: stop.
- No migrations. No status-machine, payment, or endpoint semantic changes. No new endpoints.
- Branch `feat/v7-platform-revenue` (PR #75), worktree `.claude/worktrees/v7-platform-revenue`. No subagents.
- DB-backed tests need local test Postgres: `DATABASE_URL` per memory recipe (ephemeral PG, port 54333 if 54329/54331 squatted); pure suites run without.
- Copy rules: withdraw confirm = "Frees the spot…" + auto-refund state; refund confirm = "Money only — {name} stays confirmed and keeps the spot."; fee-edit hint = "Applies to new sign-ups; current entries keep their price."
- Help-page pass is a mandatory closing step (memory rule 2026-07-13).
- Verify before push: `npx tsc --noEmit`, eslint on touched files, full `npx vitest run`, smoke, screenshots desktop + 390px.

---

### Task 1: Pure derivation lib — pulse, queue positions, duplicate hints

**Files:**
- Create: `apps/web/src/lib/registration-derive.ts`
- Test: `apps/web/src/lib/__tests__/registration-derive.test.ts`

**Interfaces:**
- Consumes: nothing (pure; row shape mirrors `RegistrationRow` fields it needs).
- Produces (Tasks 4/5 rely on these exact signatures):
  - `interface DerivableReg { id: string; status: "pending"|"paid"|"confirmed"|"waitlisted"|"withdrawn"|"expired"; contact_email: string; amount_cents: number; refunded_cents: number; refunded_at: string|Date|null; payment_method: "offline"|"stripe"|null; expires_at: string|Date|null; disputed_at: string|Date|null; created_at: string|Date; }`
  - `registrationPulse(rows: DerivableReg[], capacity: number|null): Pulse` where `interface Pulse { confirmed: number; holding: number; waitlisted: number; capacity: number|null; paidCents: number; dueCents: number; refundIncomplete: number; disputed: number; nextExpiry: string|null }`
  - `waitlistPositions(rows: DerivableReg[]): Map<string, number>` (1-based, `created_at` asc then id asc, waitlisted rows only)
  - `duplicateContactIds(rows: DerivableReg[]): Set<string>` (ids of ACTIVE rows — pending/paid/confirmed/waitlisted — whose lowercased trimmed `contact_email` appears on ≥2 active rows)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/__tests__/registration-derive.test.ts
// PROMPT-52: organiser console derivations are pure functions over the row
// set the panel already loads — spec 2026-07-13 "Data" section. Semantics
// (who holds a spot, what counts as due) mirror spec 2026-07-12 §2.
import { describe, expect, it } from "vitest";
import {
  duplicateContactIds,
  registrationPulse,
  waitlistPositions,
  type DerivableReg,
} from "../registration-derive";

let n = 0;
const reg = (patch: Partial<DerivableReg>): DerivableReg => ({
  id: `r${++n}`,
  status: "confirmed",
  contact_email: `p${n}@x.test`,
  amount_cents: 0,
  refunded_cents: 0,
  refunded_at: null,
  payment_method: null,
  expires_at: null,
  disputed_at: null,
  created_at: new Date(2026, 0, n).toISOString(),
  ...patch,
});

describe("registrationPulse", () => {
  it("counts spot-holders and waitlist against capacity", () => {
    const rows = [
      reg({ status: "confirmed" }),
      reg({ status: "pending" }),
      reg({ status: "paid" }),
      reg({ status: "waitlisted" }),
      reg({ status: "withdrawn" }),
      reg({ status: "expired" }),
    ];
    const p = registrationPulse(rows, 4);
    expect(p).toMatchObject({ confirmed: 1, holding: 2, waitlisted: 1, capacity: 4 });
  });

  it("rolls up money: paid, due, refund-incomplete, disputed, next expiry", () => {
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    const later = new Date(Date.now() + 7_200_000).toISOString();
    const rows = [
      reg({ status: "confirmed", amount_cents: 1900, payment_method: "stripe" }),
      reg({ status: "pending", amount_cents: 1900, payment_method: "stripe", expires_at: later }),
      reg({ status: "pending", amount_cents: 500, payment_method: "offline" }),
      reg({ status: "pending", amount_cents: 1000, payment_method: "stripe", expires_at: soon }),
      // refund started but not complete: refunded_at set, refunded < amount
      reg({ status: "confirmed", amount_cents: 2000, refunded_cents: 500, refunded_at: soon }),
      reg({ status: "confirmed", amount_cents: 1500, disputed_at: soon }),
    ];
    const p = registrationPulse(rows, null);
    expect(p.paidCents).toBe(1900 + 2000 + 1500); // confirmed rows with a fee snapshot
    expect(p.dueCents).toBe(1900 + 500 + 1000); // pending rows still owing
    expect(p.refundIncomplete).toBe(1);
    expect(p.disputed).toBe(1);
    expect(p.nextExpiry).toBe(soon);
  });

  it("zeroes cleanly on an empty division", () => {
    expect(registrationPulse([], 8)).toEqual({
      confirmed: 0, holding: 0, waitlisted: 0, capacity: 8,
      paidCents: 0, dueCents: 0, refundIncomplete: 0, disputed: 0, nextExpiry: null,
    });
  });
});

describe("waitlistPositions", () => {
  it("orders 1-based by created_at among waitlisted rows only", () => {
    const a = reg({ status: "waitlisted", created_at: "2026-01-02T00:00:00Z" });
    const b = reg({ status: "waitlisted", created_at: "2026-01-01T00:00:00Z" });
    const c = reg({ status: "pending", created_at: "2026-01-01T00:00:00Z" });
    const pos = waitlistPositions([a, b, c]);
    expect(pos.get(b.id)).toBe(1);
    expect(pos.get(a.id)).toBe(2);
    expect(pos.has(c.id)).toBe(false);
  });

  it("breaks created_at ties by id", () => {
    const t = "2026-01-01T00:00:00Z";
    const a = reg({ id: "aaa", status: "waitlisted", created_at: t });
    const b = reg({ id: "bbb", status: "waitlisted", created_at: t });
    const pos = waitlistPositions([b, a]);
    expect(pos.get("aaa")).toBe(1);
    expect(pos.get("bbb")).toBe(2);
  });
});

describe("duplicateContactIds", () => {
  it("flags active rows sharing an email, case/space-insensitively", () => {
    const a = reg({ status: "confirmed", contact_email: "Mum@Family.test " });
    const b = reg({ status: "waitlisted", contact_email: "mum@family.test" });
    const c = reg({ status: "pending", contact_email: "solo@x.test" });
    const dup = duplicateContactIds([a, b, c]);
    expect(dup).toEqual(new Set([a.id, b.id]));
  });

  it("ignores terminal rows — re-registering after withdrawal is legal", () => {
    const gone = reg({ status: "withdrawn", contact_email: "again@x.test" });
    const back = reg({ status: "confirmed", contact_email: "again@x.test" });
    expect(duplicateContactIds([gone, back]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/lib/__tests__/registration-derive.test.ts`
Expected: FAIL — "Cannot find module '../registration-derive'"

- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/registration-derive.ts
// PROMPT-52 organiser-console derivations. Pure + client-safe: the panel
// already loads every registration row for the division, so the pulse, the
// queue, and duplicate hints are lens functions over that array — the v1
// list API shape stays untouched for external consumers.

export interface DerivableReg {
  id: string;
  status: "pending" | "paid" | "confirmed" | "waitlisted" | "withdrawn" | "expired";
  contact_email: string;
  amount_cents: number;
  refunded_cents: number;
  refunded_at: string | Date | null;
  payment_method: "offline" | "stripe" | null;
  expires_at: string | Date | null;
  disputed_at: string | Date | null;
  created_at: string | Date;
}

export interface Pulse {
  confirmed: number;
  holding: number;
  waitlisted: number;
  capacity: number | null;
  paidCents: number;
  dueCents: number;
  refundIncomplete: number;
  disputed: number;
  nextExpiry: string | null;
}

const ACTIVE = new Set(["pending", "paid", "confirmed", "waitlisted"]);

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function registrationPulse(rows: DerivableReg[], capacity: number | null): Pulse {
  const p: Pulse = {
    confirmed: 0, holding: 0, waitlisted: 0, capacity,
    paidCents: 0, dueCents: 0, refundIncomplete: 0, disputed: 0, nextExpiry: null,
  };
  for (const r of rows) {
    if (r.status === "confirmed") p.confirmed += 1;
    else if (r.status === "pending" || r.status === "paid") p.holding += 1;
    else if (r.status === "waitlisted") p.waitlisted += 1;

    // Money reads follow the SNAPSHOT amount, mirroring spec §2/§8: what a
    // row owes/paid never moves with live settings.
    if (r.status === "pending" && r.amount_cents > 0) p.dueCents += r.amount_cents;
    if ((r.status === "confirmed" || r.status === "paid") && r.amount_cents > 0) {
      p.paidCents += r.amount_cents;
    }
    if (r.refunded_at !== null && r.refunded_cents < r.amount_cents) p.refundIncomplete += 1;
    if (r.disputed_at !== null && ACTIVE.has(r.status)) p.disputed += 1;
    if (r.status === "pending" && r.expires_at !== null) {
      const e = iso(r.expires_at);
      if (p.nextExpiry === null || e < p.nextExpiry) p.nextExpiry = e;
    }
  }
  return p;
}

export function waitlistPositions(rows: DerivableReg[]): Map<string, number> {
  const queue = rows
    .filter((r) => r.status === "waitlisted")
    .sort((a, b) => iso(a.created_at).localeCompare(iso(b.created_at)) || a.id.localeCompare(b.id));
  return new Map(queue.map((r, i) => [r.id, i + 1]));
}

export function duplicateContactIds(rows: DerivableReg[]): Set<string> {
  const byEmail = new Map<string, string[]>();
  for (const r of rows) {
    if (!ACTIVE.has(r.status)) continue;
    const key = r.contact_email.trim().toLowerCase();
    if (key === "") continue;
    byEmail.set(key, [...(byEmail.get(key) ?? []), r.id]);
  }
  const dup = new Set<string>();
  for (const ids of byEmail.values()) if (ids.length >= 2) for (const id of ids) dup.add(id);
  return dup;
}
```

- [ ] **Step 4: Run to verify pass** — same command, expected PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/registration-derive.ts apps/web/src/lib/__tests__/registration-derive.test.ts
git commit -m "feat(reg): pure console derivations — pulse, queue, dupes"
```

**Note (paid semantics):** `paidCents` counts confirmed/paid rows with a snapshot amount (waived rows carry `amount_cents` per snapshot but were confirmed without payment — spec treats Waive as comp entry; if the Step-4 run shows the PR #72 fixtures distinguish waived via `amount_cents` intact + no `payment_intent_id` and that skews numbers, do NOT change the suite — refine `paidCents` to `payment_intent_id !== null || offline_marked_paid_at !== null` rows by adding those two nullable fields to `DerivableReg`, update this test accordingly, and note it in the commit body.)

---

### Task 2: Public reads — `waitlisted` count + queue `position` (DB-backed TDD)

**Files:**
- Modify: `apps/web/src/server/usecases/registrations.ts` (`PublicDivisionInfo` ~582, `publicRegistrationInfo` query ~639-689, `PublicStatusView` ~1187, `publicRegistrationStatus` ~1223)
- Test: Create `apps/web/src/server/usecases/__tests__/reg-console-public.test.ts` (new file — PR #72 suite stays untouched)

**Interfaces:**
- Produces: `PublicDivisionInfo.waitlisted: number`; `PublicStatusView.position: number | null` (1-based, only while `status === "waitlisted"`, else null). Task 5 consumes both.

- [ ] **Step 1: Start the local test Postgres** (memory recipe; skip if already up)

Run: `pg_isready -h localhost -p 54333 || (initdb/docker per memory project_local_test_db, migrate via db:apply)` — then `export DATABASE_URL=postgresql://localhost:54333/seazn_test`

- [ ] **Step 2: Write the failing tests**

```ts
// apps/web/src/server/usecases/__tests__/reg-console-public.test.ts
// PROMPT-52 public reads: waitlist count on the division card and "#N in
// line" on the token-gated status page. New file — the PR #72 suite is
// normative and must stay byte-identical. Real Postgres, skipped without
// DATABASE_URL (same convention as registrations.test.ts).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import {
  publicRegistrationInfo,
  publicRegistrationStatus,
  putRegistrationSettings,
  submitRegistration,
} from "../registrations";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedOrg(): Promise<{ auth: AuthCtx; orgSlug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await sql<{ id: string }[]>`
    insert into users (display_name, email)
    values (${"P52 " + suffix}, ${`p52_${suffix}@test.local`}) returning id`;
  const [org] = await sql<{ id: string; slug: string }[]>`
    insert into organizations (name, slug, visibility)
    values (${"P52 Org " + suffix}, ${"p52-org-" + suffix}, 'public') returning id, slug`;
  await sql`insert into org_members (org_id, user_id, role) values (${org!.id}, ${user!.id}, 'owner')`;
  return { auth: { orgId: org!.id, userId: user!.id, via: "session" } as AuthCtx, orgSlug: org!.slug };
}

describe.skipIf(!HAS_DB)("PROMPT-52 public waitlist reads", () => {
  it("exposes waitlisted count on PublicDivisionInfo and #N on the status page", async () => {
    const { auth, orgSlug } = await seedOrg();
    const comp = await createCompetition(auth, { name: "P52 Cup", visibility: "public" });
    const div = await createDivision(auth, comp.id, { name: "Open", sport_key: "generic", entrant_kind: "individual" });
    await putRegistrationSettings(auth, div.id, { enabled: true, capacity: 1, fee_cents: 0 });

    await submitRegistration(orgSlug, comp.slug, div.slug, { display_name: "Holder", contact_email: "h@x.test", answers: {} });
    const w1 = await submitRegistration(orgSlug, comp.slug, div.slug, { display_name: "First Wait", contact_email: "w1@x.test", answers: {} });
    const w2 = await submitRegistration(orgSlug, comp.slug, div.slug, { display_name: "Second Wait", contact_email: "w2@x.test", answers: {} });

    const info = await publicRegistrationInfo(orgSlug, comp.slug);
    expect(info.divisions[0]!.waitlisted).toBe(2);

    const s1 = await publicRegistrationStatus(w1.id, w1.access_token!);
    const s2 = await publicRegistrationStatus(w2.id, w2.access_token!);
    expect(s1.status).toBe("waitlisted");
    expect(s1.position).toBe(1);
    expect(s2.position).toBe(2);
  });

  it("position is null once not waitlisted", async () => {
    const { auth, orgSlug } = await seedOrg();
    const comp = await createCompetition(auth, { name: "P52 Cup B", visibility: "public" });
    const div = await createDivision(auth, comp.id, { name: "Open", sport_key: "generic", entrant_kind: "individual" });
    await putRegistrationSettings(auth, div.id, { enabled: true, capacity: 5, fee_cents: 0 });
    const r = await submitRegistration(orgSlug, comp.slug, div.slug, { display_name: "In", contact_email: "in@x.test", answers: {} });
    const s = await publicRegistrationStatus(r.id, r.access_token!);
    expect(s.status).not.toBe("waitlisted");
    expect(s.position).toBeNull();
  });
});

afterAll(async () => {
  if (HAS_DB) await sql.end();
});
```

**Adjust seeding calls to the real signatures** (`createCompetition`/`createDivision`/`putRegistrationSettings`/`submitRegistration` argument shapes) by copying the exact invocation style from `registrations.test.ts` setup helpers — read that file's `beforeEach`/helpers first; the test bodies' assertions above are the contract, the seeding lines may need the suite's actual helper shapes.

- [ ] **Step 3: Run to verify failure** — `npx vitest run src/server/usecases/__tests__/reg-console-public.test.ts` with DATABASE_URL set. Expected: FAIL — `waitlisted`/`position` undefined.

- [ ] **Step 4: Implement (additive fields only)**

In `publicRegistrationInfo`'s divisions query add a second correlated count and pass it through:

```sql
(select count(*)::int from registrations r
  where r.division_id = rs.division_id
    and r.status = 'waitlisted') as waitlisted
```

- add `waitlisted: number` to the row type union, `waitlisted: r.waitlisted` to the mapped object, and to `PublicDivisionInfo` with doc comment `/** Queue length behind a full division (PROMPT-52) — public. */`.

In `publicRegistrationStatus` compute position only for waitlisted rows (1-based, created_at then id — identical ordering to promotion's oldest-first and Task 1's `waitlistPositions`):

```ts
const [posRow] = reg.status === "waitlisted"
  ? await sql<{ position: number }[]>`
      select count(*)::int as position from registrations
      where division_id = ${reg.division_id} and status = 'waitlisted'
        and (created_at, id) <= (${reg.created_at}, ${reg.id})`
  : [];
```

- add `position: posRow?.position ?? null` to the returned object and `position: number | null` to `PublicStatusView` with doc comment `/** 1-based place in the waitlist queue; null unless waitlisted (PROMPT-52). */`.

- [ ] **Step 5: Run to verify pass** — same command, expected PASS (2 tests). Then the frozen suite: `npx vitest run src/server/usecases/__tests__/registrations.test.ts` — expected PASS 44, **zero file changes** (`git diff --stat` shows registrations.test.ts absent).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/usecases/registrations.ts apps/web/src/server/usecases/__tests__/reg-console-public.test.ts
git commit -m "feat(reg): public waitlist count + queue position reads"
```

---

### Task 3: Settings accordion — extract `registration-settings.tsx`

**Files:**
- Create: `apps/web/src/components/v2/registration-settings.tsx`
- Modify: `apps/web/src/components/v2/registrations-panel.tsx` (settings `<section>` lines ~292-490 move out; FormBuilder stays in-panel-file or moves with it — keep FormBuilder where the smaller diff lands)

**Interfaces:**
- Consumes: the panel's existing `Settings` type, `set(patch)`, `save()`, `feeText/setFeeText`, `paidAllowed`, `canEdit`, `busy/saved/error` — pass as props, signatures copied verbatim from the current panel body.
- Produces: `<RegistrationSettings settings={...} onPatch={set} onSave={save} feeText={feeText} onFeeText={setFeeText} canEdit paidAllowed busy saved capacityMeter={pulse} />` — `capacityMeter` is Task 1's `Pulse` (taken/held/waitlisted read inline under the capacity input).

- [ ] **Step 1:** Move the settings JSX into the new file unchanged, then regroup into four `<details>`-style staged disclosure groups (use the existing `.card` + a `<button aria-expanded>` header per group, first group open by default): **Open & close** (enabled, entrant kind, opens/closes window) → **Capacity** (input + inline meter `“{confirmed+holding} taken · {waitlisted} waiting”`) → **Money** (fee + method picker + instructions + refund lock; fee field hint text exactly: `Applies to new sign-ups; current entries keep their price.`; Connect state stays a LINK to `/o/[orgSlug]/settings/payments`) → **Sign-up form** (FormBuilder untouched).
- [ ] **Step 2:** `npx tsc --noEmit` clean; `npx vitest run` (no UI unit tests — compile + existing suites are the gate here).
- [ ] **Step 3:** Commit — `feat(reg): settings column becomes staged accordion`.

---

### Task 4: Pulse + tabs + queue + SPOT/MONEY clusters — panel becomes a shell

**Files:**
- Create: `apps/web/src/components/v2/registration-pulse.tsx`, `apps/web/src/components/v2/waitlist-queue.tsx`, `apps/web/src/components/v2/registration-list.tsx`
- Modify: `apps/web/src/components/v2/registrations-panel.tsx` (list `<section>` ~503-636 replaced; panel keeps state + `run/refresh/action` and composes)

**Interfaces:**
- Consumes: Task 1 exports; panel's existing `Registration` client type, `action(id, verb)` handlers, `paymentChip`, `hoursLeft`, ref/name filter.
- Produces:
  - `<RegistrationPulse pulse={Pulse} currency={string} onJump={(tab: Tab) => void} />` — every number a button activating the matching tab.
  - `type Tab = "confirmed" | "pending" | "waitlist" | "all"`
  - `<RegistrationList rows={Registration[]} tab={Tab} onTab={fn} duplicates={Set<string>} positions={Map<string,number>} …existing action props />` — tab labels carry counts; rows show `paymentChip`, stripe-pending countdown (`hoursLeft`), duplicate marker `⚠ same contact as another active entry` (non-blocking, title tooltip).
  - `<WaitlistQueue rows={Registration[]} positions={Map<string,number>} onPromote={(id) => void} canEdit={boolean} />` — ordered by position; renders `#N`, name, joined-at, Promote (calls the panel's existing waitlist→confirm/promote action unchanged).
- Action clusters inside `RegistrationList` rows: two labeled groups — `SPOT [Withdraw…]`, `MONEY [Refund…] [Waive] [Mark paid]`; confirm copy verbatim from Global Constraints; wire to the panel's existing `action()` verbs, endpoints untouched.

- [ ] **Step 1:** Build the three components + rewire the panel: derive `pulse/positions/duplicates` via `useMemo` from `regs` + `settings.capacity`; default tab = `all` when division empty else `confirmed`; keep search filter working across tabs.
- [ ] **Step 2:** `npx tsc --noEmit` + `npx vitest run` green; eslint touched files.
- [ ] **Step 3:** Visual pass (dev server on :3100, org console with seeded demo division): screenshots desktop 1440 + 390px; no horizontal scroll (`document.documentElement.scrollWidth === 390`).
- [ ] **Step 4:** Commit — `feat(reg): pulse + status tabs + queue + SPOT/MONEY clusters`.

---

### Task 5: Public surfaces — division card waitlist count, status page "#N in line"

**Files:**
- Modify: the register panel/card component consuming `PublicDivisionInfo` (locate via `grep -rn "closed_reason\|joins the waitlist" apps/web/src/components apps/web/src/app/(public)`) — when `closed_reason === "full"` and `waitlisted > 0`, copy becomes `Full — waitlist: {waitlisted}` (keep the existing "joins the waitlist" submit affordance).
- Modify: `apps/web/src/app/(public)/shared/[orgSlug]/[competitionSlug]/register/status/page.tsx` (or its client component) — when `status === "waitlisted" && position !== null`, render `You're #{position} in line — we'll email you if a spot opens.`

**Interfaces:** Consumes Task 2's `waitlisted` + `position` fields.

- [ ] **Step 1:** Implement both copy additions following each file's existing markup conventions.
- [ ] **Step 2:** `npx tsc --noEmit`; visual check of both surfaces (public comp page + a waitlisted registration's status link) with screenshots.
- [ ] **Step 3:** Commit — `feat(reg): public waitlist count + queue position copy`.

---

### Task 6: e2e + smoke

**Files:**
- Create: `apps/web/e2e/reg-console.spec.ts` (follow `e2e/helpers.ts` conventions: `loginUi`, SQL helpers, dev-server assumptions)
- Modify: `scripts/smoke.ts` (extend the registration checks in `gapSuite` or add `regConsoleSuite` called from `main()`)

- [ ] **Step 1: e2e spec** — seed via API: division capacity 1, three submissions (1 confirmed-path holder, 2 waitlisted). Assert: pulse strip shows `1` + `2 waitlisted` and tab labels match; Waitlist tab rows render `#1`/`#2` in joined order; token status page of the second waitlisted shows `#2 in line`; public register card shows `Waitlist: 2`. Run: `npx playwright test e2e/reg-console.spec.ts --project=parallel` against the worktree dev server. Expected: green (skips cleanly if server absent, matching existing specs).
- [ ] **Step 2: smoke** — after the existing gap registration checks: submit past capacity, then `check("reg pulse counts", …)` via `GET /api/v1/public/registrations/[id]` position field + `publicRegistrationInfo`-backed public JSON (`/api/...` route the card uses); assert waitlisted count ≥1 and `position === 1` for the first waitlisted row. Run full smoke against dev server: expected all PASS.
- [ ] **Step 3:** Commit — `test(reg): console e2e + smoke coverage for queue/pulse`.

---

### Task 7: Help pages + full verify + push (closing pass — mandatory)

**Files:**
- Modify: `apps/web/content/help/registration/waitlist.md` (queue positions, public count, "#N in line", promote-next), `apps/web/content/help/registration/open-registration.md` (settings groups: Open & close / Capacity / Money / Sign-up form; fee snapshot rule), plus any file the noun-grep flags.

- [ ] **Step 1:** `grep -rn "waitlist\|withdraw\|refund\|capacity\|settings column\|mark paid" apps/web/content/help/` — update every stale description to the new console (tabs, clusters, accordion); article copy mirrors UI copy verbatim where it quotes buttons.
- [ ] **Step 2:** Full gate: `npx tsc --noEmit`; eslint on all touched files; `npx vitest run` (with DATABASE_URL: frozen suite 44 PASS + new suites green; `git status` proves `registrations.test.ts` untouched); smoke run; screenshots (desktop + 390) attached to PR.
- [ ] **Step 3:** Commit `docs(help): registration articles match the new console`, push, update PR #75 body: PROMPT-52 section (decisions, no-API-change note for organiser derivations, additive public fields, evidence).

---

## Self-review notes

- Spec coverage: pulse (T1/T4), queue + exposure (T1/T2/T4/T5), action clarity (T4), settings hierarchy (T3), duplicate hint (T1/T4), help (T7), PR #72 frozen (T2/T7 gates), mobile 390 (T4/T7). No gaps.
- Task 2 seeding shapes flagged explicitly as copy-from-suite — intentional: the frozen suite is the single source of truth for helper signatures; do not guess them here.
- Type names consistent: `Pulse`, `Tab`, `DerivableReg`, `waitlisted`, `position` used identically across tasks.
