# Wave 4: credit-economics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument AI-run cost/size with a COGS-vs-sold admin margin panel and a 2×-median cost alert (#295); gate the onboarding and referral-welcome earn grants on a published-competition-with-division signal instead of signup, with a daily volume backstop alert (#296); and ratify "credits never expire" in the design docs to match what already shipped (#297).

**Branch:** `feat/v17gap-w4-credit-economics` (git worktree — NEVER checkout in main repo dir)
**Issues:** #295 #296 #297
**Depends on:** W1 money-leaks, W2 resolver-truth, W3 grant-correct (all merged to `main` before this wave starts)

## Global Constraints

- This repo's Next.js has breaking changes vs training data — read the relevant guide in `node_modules/next/dist/docs/` before writing any Next-specific code.
- Tests: vitest, run from `apps/web`. Every behaviour change ships a regression test that FAILS without the change.
- Billing code: `BILLING_LIVE=1` live suites (`*.live.test.ts`) vs test-mode Stripe (sk_test in main repo `.env.local`; 30s timeout — 5s default times out). Follow stripe:stripe-best-practices.
- Migrations: Flyway via `npm run db:apply`; local ephemeral test PG on :54329; always `search_path=seazn_club`. Migration numbers are assigned per-wave in this plan — do not renumber.
- i18n: every new/changed user-facing string in ALL FOUR locales (en/es/fr/nl); dicts are FLAT dotted-key JSON; run gen-keys + i18n:check. Client components import `@/lib/i18n-runtime`, never `@/lib/i18n`.
- UI: app is LIGHT-ONLY (dark only under /admin). Use the frontend-design skill. Every surface clean at 375px, no horizontal page scroll; wide tables in `overflow-x:auto`. Screenshot-verify before sign-off.
- UI text: grep changed strings across e2e specs (both phases) BEFORE merging; scope assertions to a container. NEVER enable `.github/workflows/e2e.yml` — e2e runs locally: prod build + `E2E_PROD_TARGET` on :3100.
- `scripts/smoke.ts` extended for behaviour changes (pro + free paths).
- Help pages: closing pass in the SAME wave, registered in the help-slug registry.
- Branch per wave in a git worktree; verify `tsc` + unit before push; `/code-review` on the branch before merge; smoke CI only runs on PRs — always merge via PR.

## ⚠️ Migration note — read before Task 1

The wave map reserves **V340 (`ai_runs.pack_units`)** for this wave. **There is no `ai_runs` table and V340 is NOT consumed.** AI runs are recorded as rows in `competition_events` (`type in ('schedule.ai_generated','schedule.ai_officials_generated','schedule.ai_failed')`, JSONB `payload`) — `apps/web/src/server/usecases/ai-runs-admin.ts` reads them back as a virtual "ai_runs" view (`listAiRuns`, `aiRunTotals`). SPEC-2 §5.3's `ai_credit_ledger.ref → ai_runs(model, tokens, cost_usd, competition_id)` line is conceptual, not a real table/FK — the ledger's `ref` (a client-generated `crypto.randomUUID()`) is never actually written into `competition_events.payload`, so the two tables cannot be joined per-row either (Task 4 works around this by reporting two independent aggregates instead of a per-run join — see its Interfaces block).

Because `pack_units` becomes a new JSONB key on an existing payload, not a new column, **this wave adds zero migrations.** If a real schema need surfaces during implementation that this plan didn't anticipate, stop and use V340 for it, and say so loudly in the commit message — do not silently skip a needed migration.

## Notes carried from research (do not re-derive)

- **Email verification already gates org creation.** `POST /api/auth/signup` (`apps/web/src/app/api/auth/signup/route.ts`) inserts the user with `email_verified=false` and issues **no session** — the account "stays inactive (no session) until the link is opened" (its own comment). `POST /api/auth/login` (`apps/web/src/app/api/auth/login/route.ts:37`) explicitly refuses `!user.email_verified`. `createOrgForUser` (`apps/web/src/lib/auth.ts:256`) is only reachable from `requireUser()`-gated routes, and `requireUser` (`apps/web/src/lib/auth.ts:111`) requires a valid session JWT. So a session — and therefore an org — cannot exist before email verification (OAuth signups verify implicitly via the provider). This answers #296's open question 1: the marginal cost of a fake account already requires a working inbox; gating the earn grants further (this wave) is still correct because email addresses are free, not because verification is missing.
- **`ai_credit_ledger`'s `earn_grant` idempotency is already correct and untouched by this wave.** `recordEarnGrant`/`tryEarnGrant` (`apps/web/src/lib/credits.ts:569-638`) key on `earn:${reason}:${ref}` and are pool-capped by `LIFETIME_EARN_CAP`. This wave only moves **call sites**, never the mechanism.
- The referrer's own +20 (`REFERRAL_EARN`, reason `"first_paid"`/`"referral"`) already fires correctly off a real payment signal (`apps/web/src/server/usecases/registrations.ts:1170-1187`) and is **not** touched by this wave — it is the pattern Task 5 reuses (best-effort, `try`/`catch`, fires after the org-mutating transaction commits, never blocks the caller).

---

### Task 1: AI run cost-alert primitives (median + decision + email)

**Files:**
- Modify: `apps/web/src/server/usecases/ai-runs-admin.ts`
- Modify: `apps/web/src/lib/email.ts`
- Test: `apps/web/src/server/usecases/__tests__/ai-run-cost-alert.test.ts` (new)

**Interfaces:**
- Consumes: `AI_RUN_EVENT_TYPES` (`ai-runs-admin.ts:8-12`, existing); `sql` from `@/lib/db`; `renderEmail`/`paragraph`/`panel` from `@/lib/email-templates/compose`, `escapeHtml` from `@/lib/email-templates/shared`, `send()` (`email.ts:113`, existing, unexported) — all existing.
- Produces (for Tasks 2 & 3): `AI_RUN_COST_ALERT_MULTIPLE: number`, `shouldAlertOnRunCost(costUsd: number | null, medianUsd: number | null, multiple?: number): boolean`, `medianRunCostUsd(eventType: "schedule.ai_generated" | "schedule.ai_officials_generated", days: number): Promise<number | null>`, `maybeAlertExpensiveRun(opts: { orgId: string; competitionId?: string; phase: "schedule" | "officials"; model: string; costUsd: number | null }): Promise<void>` — all exported from `ai-runs-admin.ts`. `sendAiRunCostAlertEmail(opts: AiRunCostAlertEmail): Promise<boolean>` exported from `email.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/usecases/__tests__/ai-run-cost-alert.test.ts`:

```ts
// v17 gap #295 — the alert SPEC-2 §5.1 named as the trigger for revisiting
// flat 1-credit-per-run pricing: a single run's cost_usd >= 2x the trailing
// median for its phase. `shouldAlertOnRunCost` carries every decision branch
// (null cost, no baseline, below/at/above the multiple) as a pure function so
// it is exhaustively testable with no DB and no flake risk from other suites
// concurrently writing competition_events. `medianRunCostUsd` and
// `maybeAlertExpensiveRun` are thin DB/email wiring on top of it; both are
// exercised against a REAL cost value ($50) that is orders above anything a
// mocked-LLM test pack can produce (SPEC-2 §6: worst observed real cost is
// ~$0.47), so the "fires" assertions stay robust even if other test files
// insert their own (tiny) competition_events rows into the same schema
// concurrently.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return { ...actual, sendAiRunCostAlertEmail: vi.fn().mockResolvedValue(true) };
});

import { sql } from "@/lib/db";
import { sendAiRunCostAlertEmail } from "@/lib/email";
import {
  AI_RUN_COST_ALERT_MULTIPLE,
  maybeAlertExpensiveRun,
  medianRunCostUsd,
  shouldAlertOnRunCost,
} from "../ai-runs-admin";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

afterEach(() => {
  vi.mocked(sendAiRunCostAlertEmail).mockClear();
  delete process.env.STAFF_ALERT_EMAIL;
});

describe("shouldAlertOnRunCost (pure, v17 gap #295)", () => {
  it("false when cost is null (nothing to compare)", () => {
    expect(shouldAlertOnRunCost(null, 0.1)).toBe(false);
  });
  it("false when there is no median yet (null or non-positive baseline)", () => {
    expect(shouldAlertOnRunCost(5, null)).toBe(false);
    expect(shouldAlertOnRunCost(5, 0)).toBe(false);
    expect(shouldAlertOnRunCost(5, -1)).toBe(false);
  });
  it("false strictly below the multiple", () => {
    expect(shouldAlertOnRunCost(0.19, 0.1, 2)).toBe(false);
  });
  it("true at or above the multiple", () => {
    expect(shouldAlertOnRunCost(0.2, 0.1, 2)).toBe(true);
    expect(shouldAlertOnRunCost(0.25, 0.1, 2)).toBe(true);
  });
  it("defaults the multiple to AI_RUN_COST_ALERT_MULTIPLE (SPEC-2 §5.1's own named trigger)", () => {
    expect(AI_RUN_COST_ALERT_MULTIPLE).toBe(2);
    expect(shouldAlertOnRunCost(0.2, 0.1)).toBe(true);
    expect(shouldAlertOnRunCost(0.19999, 0.1)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("medianRunCostUsd (v17 gap #295)", () => {
  it("returns null for a window with provably zero rows (future bound)", async () => {
    // days:-1 -> now() - make_interval(days => -1) = now() + 1 day, a bound
    // no row's created_at can ever satisfy — deterministic null regardless of
    // what other suites have written into competition_events.
    expect(await medianRunCostUsd("schedule.ai_generated", -1)).toBeNull();
  });

  it("returns a positive number once at least one qualifying row exists", async () => {
    const [org] = await sql<{ id: string }[]>`
      insert into organizations (name, slug)
      values (${"Median " + randomUUID().slice(0, 8)}, ${"median-" + randomUUID().slice(0, 8)})
      returning id`;
    const [comp] = await sql<{ id: string }[]>`
      insert into competitions (org_id, name, slug, visibility, branding)
      values (${org!.id}, 'Median Comp', ${"median-comp-" + randomUUID().slice(0, 8)}, 'private', '{}')
      returning id`;
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${comp!.id}, ${org!.id}, 'schedule.ai_generated', ${sql.json({ cost_usd: 0.01 })})`;
    const median = await medianRunCostUsd("schedule.ai_generated", 1);
    expect(typeof median).toBe("number");
    expect(median).toBeGreaterThan(0);
  });
});

describe.skipIf(!HAS_DB)("maybeAlertExpensiveRun (v17 gap #295)", () => {
  it("never emails when STAFF_ALERT_EMAIL is unset, even for an extreme cost", async () => {
    delete process.env.STAFF_ALERT_EMAIL;
    await maybeAlertExpensiveRun({
      orgId: randomUUID(),
      phase: "schedule",
      model: "claude-sonnet-5",
      costUsd: 50,
    });
    expect(sendAiRunCostAlertEmail).not.toHaveBeenCalled();
  });

  it("alerts when a run's cost is astronomically above the trailing median", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    const orgId = randomUUID();
    await maybeAlertExpensiveRun({
      orgId,
      competitionId: "comp-1",
      phase: "schedule",
      model: "claude-sonnet-5",
      costUsd: 50, // no realistic AI run (SPEC-2 §6: worst ~$0.47) gets near this
    });
    expect(sendAiRunCostAlertEmail).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendAiRunCostAlertEmail).mock.calls[0]![0];
    expect(args.orgId).toBe(orgId);
    expect(args.competitionId).toBe("comp-1");
    expect(args.phase).toBe("schedule");
    expect(args.costUsd).toBe(50);
    expect(args.medianUsd).toBeGreaterThan(0);
  });

  it("never throws — a check failure is swallowed", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    vi.mocked(sendAiRunCostAlertEmail).mockRejectedValueOnce(new Error("boom"));
    await expect(
      maybeAlertExpensiveRun({ orgId: randomUUID(), phase: "officials", model: "x", costUsd: 50 }),
    ).resolves.toBeUndefined();
  });

  it("does nothing for a null cost (nothing to compare)", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    await maybeAlertExpensiveRun({ orgId: randomUUID(), phase: "schedule", model: "x", costUsd: null });
    expect(sendAiRunCostAlertEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/web`): `npx vitest run src/server/usecases/__tests__/ai-run-cost-alert.test.ts`
Expected: FAIL — `shouldAlertOnRunCost`, `medianRunCostUsd`, `maybeAlertExpensiveRun`, `AI_RUN_COST_ALERT_MULTIPLE` don't exist on `../ai-runs-admin`, and `sendAiRunCostAlertEmail` doesn't exist on `@/lib/email` (module resolution / TS errors).

- [ ] **Step 3: Write minimal implementation**

Append to `apps/web/src/server/usecases/ai-runs-admin.ts` (after `aiRunTotals`, end of file):

```ts

import { sendAiRunCostAlertEmail } from "@/lib/email";

/** SPEC-2 §5.1's own named trigger for revisiting flat 1-credit-per-run
 *  pricing (v17 gap #295): "a run class > ~2x median COGS". */
export const AI_RUN_COST_ALERT_MULTIPLE = 2;

/** Pure decision: should a run at `costUsd` trip the expensive-run alert
 *  against a `medianUsd` baseline? Split out from the DB/email wiring below
 *  so every branch (no cost, no baseline yet, below/at/above the multiple)
 *  is unit-testable without a database. */
export function shouldAlertOnRunCost(
  costUsd: number | null,
  medianUsd: number | null,
  multiple: number = AI_RUN_COST_ALERT_MULTIPLE,
): boolean {
  if (costUsd == null) return false;
  if (medianUsd == null || medianUsd <= 0) return false;
  return costUsd >= medianUsd * multiple;
}

/** Trailing-window median `cost_usd` for one phase's SUCCESSFUL runs (v17 gap
 *  #295) — the baseline `maybeAlertExpensiveRun` compares a fresh run
 *  against. Scoped to the phase's own SUCCESS event type
 *  (schedule.ai_generated / schedule.ai_officials_generated), never
 *  schedule.ai_failed, whose cost distribution is a different thing (aborted
 *  / retried runs). `null` when the window has no qualifying row yet — there
 *  is no baseline to compare against. Global across orgs/divisions by
 *  design: SPEC-2 §5.1 frames the trigger as a platform-wide pricing
 *  question, not a per-org one. */
export async function medianRunCostUsd(
  eventType: "schedule.ai_generated" | "schedule.ai_officials_generated",
  days: number,
): Promise<number | null> {
  const [row] = await sql<{ median: number | null }[]>`
    select percentile_cont(0.5) within group (order by (payload->>'cost_usd')::numeric) as median
      from competition_events
     where type = ${eventType}
       and payload->>'cost_usd' is not null
       and created_at >= now() - make_interval(days => ${days})`;
  return row?.median != null ? Number(row.median) : null;
}

const MEDIAN_WINDOW_DAYS = 30;

/** Best-effort staff alert (v17 gap #295): fires when a just-completed run's
 *  cost trips `shouldAlertOnRunCost` against the trailing 30-day median for
 *  its phase. Never throws — a check failure must not fail an AI run that
 *  already succeeded (same discipline as every other post-commit alert in
 *  this codebase, e.g. `sendCreditPackGrantFailedAlertEmail`'s call site).
 *  Silent (no email attempted) when `STAFF_ALERT_EMAIL` is unset, matching
 *  every other alert in `billing-events.ts`/`pass-credit.ts`. */
export async function maybeAlertExpensiveRun(opts: {
  orgId: string;
  competitionId?: string;
  phase: "schedule" | "officials";
  model: string;
  costUsd: number | null;
}): Promise<void> {
  try {
    const eventType = opts.phase === "schedule" ? "schedule.ai_generated" : "schedule.ai_officials_generated";
    const median = await medianRunCostUsd(eventType, MEDIAN_WINDOW_DAYS);
    if (!shouldAlertOnRunCost(opts.costUsd, median)) return;
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (!alertTo) return;
    await sendAiRunCostAlertEmail({
      to: alertTo,
      orgId: opts.orgId,
      ...(opts.competitionId ? { competitionId: opts.competitionId } : {}),
      phase: opts.phase,
      model: opts.model,
      costUsd: opts.costUsd as number,
      medianUsd: median as number,
    });
  } catch (err) {
    console.error(`[ai-runs] expensive-run alert check failed (org ${opts.orgId})`, err);
  }
}
```

Insert into `apps/web/src/lib/email.ts` right before `export function emailConfigured(): boolean {` (currently the file's last export, line 798):

```ts
export interface AiRunCostAlertEmail {
  to: string;
  orgId: string;
  competitionId?: string;
  phase: "schedule" | "officials";
  model: string;
  costUsd: number;
  medianUsd: number;
}

/** Internal staff alert (v17 gap #295): a single AI run's cost landed at or
 *  above AI_RUN_COST_ALERT_MULTIPLE x the trailing 30-day median for its
 *  phase — the exact trigger SPEC-2 §5.1 named for revisiting the flat
 *  1-credit-per-run price. Ops-only, no user-facing i18n (mirrors
 *  sendStuckEventsAlertEmail). Not deduped — a run class that keeps tripping
 *  this is the point, not a bug to suppress. */
export async function sendAiRunCostAlertEmail(opts: AiRunCostAlertEmail): Promise<boolean> {
  const multiple = opts.medianUsd > 0 ? opts.costUsd / opts.medianUsd : null;
  const subject = `Expensive AI run: $${opts.costUsd.toFixed(4)} (org ${opts.orgId})`;
  const bodyText =
    `A ${opts.phase} AI run for org ${opts.orgId}` +
    `${opts.competitionId ? ` (competition ${opts.competitionId})` : ""} cost $${opts.costUsd.toFixed(4)} on ` +
    `${opts.model}${multiple ? `, ${multiple.toFixed(1)}x the trailing 30-day ${opts.phase} median ($${opts.medianUsd.toFixed(4)})` : ""}. ` +
    `Size-weighted credit pricing is deferred until this class of run recurs — see v17 gap #295.`;
  const html = renderEmail({
    subject,
    preheader: `${opts.phase} run — org ${opts.orgId}`,
    eyebrow: "AI credits · Margin",
    title: "Expensive AI run",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel(
        "Run",
        `org: ${opts.orgId}${opts.competitionId ? `\ncompetition: ${opts.competitionId}` : ""}\n` +
          `phase: ${opts.phase}\nmodel: ${opts.model}\ncost: $${opts.costUsd.toFixed(4)}\n` +
          `median: $${opts.medianUsd.toFixed(4)}`,
      ),
    footerNote: "Automated staff alert — AI run cost check (v17 gap #295).",
  });
  const text =
    `${bodyText}\n\norg: ${opts.orgId} · phase: ${opts.phase} · model: ${opts.model} · ` +
    `cost $${opts.costUsd.toFixed(4)} · median $${opts.medianUsd.toFixed(4)}`;
  return send({ to: opts.to, transactional: true, subject, html, text });
}

```

Note: move the `import { sendAiRunCostAlertEmail } from "@/lib/email";` line in `ai-runs-admin.ts` up to the top import block (next to `import { sql } from "@/lib/db";`) instead of mid-file — TypeScript allows either, but keep imports grouped at the top per this codebase's convention (every other file in this plan does the same).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/usecases/__tests__/ai-run-cost-alert.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/ai-runs-admin.ts apps/web/src/lib/email.ts apps/web/src/server/usecases/__tests__/ai-run-cost-alert.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-runs): expensive-run alert primitives

SPEC-2 §5.1's named trigger for revisiting flat 1-credit pricing: a
run costing >=2x the trailing 30-day phase median. Pure decision +
median query + best-effort email, reusing the STAFF_ALERT_EMAIL /
send*AlertEmail pattern already used for billing anomalies.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire pack_units + expensive-run alert into schedule-ai.ts

**Files:**
- Modify: `apps/web/src/server/usecases/schedule-ai.ts`
- Test: `apps/web/src/server/usecases/__tests__/schedule-ai-route.test.ts`

**Interfaces:**
- Consumes: `maybeAlertExpensiveRun` (Task 1, `@/server/usecases/ai-runs-admin`); `aiPlanForDivision(auth, divisionId, input)` (existing, `schedule-ai.ts:1464`); `movableIds: Set<string>` (existing local, from `buildSchedulePack`, `schedule-ai.ts:1516`); `gate.competitionId: string` (existing local, `schedule-ai.ts:1490`).
- Produces: `competition_events` rows of type `schedule.ai_generated` / `schedule.ai_failed` now carry a `pack_units: number` payload key (the same fixture count already sent to PostHog as `fixtures`).

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/usecases/__tests__/schedule-ai-route.test.ts`. First, mock `maybeAlertExpensiveRun` — add this block right after the existing `vi.mock("@/lib/cache", ...)` block (before the `import { sql } from "@/lib/db";` line):

```ts
const maybeAlertExpensiveRun = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/usecases/ai-runs-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-runs-admin")>();
  return { ...actual, maybeAlertExpensiveRun };
});
```

Then add this import next to the other local imports (near `import { aiPlanForDivision } from "../schedule-ai";`):

```ts
import { maybeAlertExpensiveRun as maybeAlertExpensiveRunSpy } from "../ai-runs-admin";
```

(`maybeAlertExpensiveRunSpy` avoids a name clash with the hoisted `maybeAlertExpensiveRun` mock function above — both point at the same `vi.fn()`, but the second import gives readable `.mock.calls` access alongside the rest of the file's `vi.mocked(...)` style.)

Add `maybeAlertExpensiveRun.mockClear();` to the existing `beforeEach` block. Then add a new `it()` inside `describe.skipIf(!HAS_DB)("aiPlanForDivision gates (v4/00 §5, credit-metered v17)", ...)`, right after the existing "run ledger carries model/usage/cost" test:

```ts
  it("records pack_units alongside cost, and calls the expensive-run alert check with the run's numbers (v17 gap #295)", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds } = await seedPlannable(auth);
    parse.mockResolvedValueOnce(planResponse(legalPlan(fixtureIds)));

    await aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" });

    const [ok] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_generated' and payload->>'division_id' = ${divisionId}`;
    // buildSchedulePack put every fixture in scope (no repair scope) — pack_units
    // is the same count already reported to PostHog as `fixtures`.
    expect(ok!.payload.pack_units).toBe(fixtureIds.length);

    expect(maybeAlertExpensiveRun).toHaveBeenCalledTimes(1);
    const call = maybeAlertExpensiveRunSpy.mock.calls[0]![0] as {
      orgId: string;
      competitionId: string;
      phase: string;
      model: string;
      costUsd: number | null;
    };
    expect(call.orgId).toBe(auth.orgId);
    expect(call.phase).toBe("schedule");
    expect(typeof call.costUsd).toBe("number");

    // Failures carry pack_units too (same fixture count the failed attempt saw).
    parse.mockResolvedValueOnce({
      parsed_output: null,
      stop_reason: "refusal",
      usage: { input_tokens: 700, output_tokens: 40 },
    });
    await expect(
      aiPlanForDivision(auth, divisionId, { instruction: "plan", mode: "generate" }),
    ).rejects.toMatchObject({ code: "AI_PLAN_FAILED" });
    const [failed] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_failed' and payload->>'division_id' = ${divisionId}`;
    expect(failed!.payload.pack_units).toBe(fixtureIds.length);
    // A failed run is not compared for the expensive-run alert (only ok).
    expect(maybeAlertExpensiveRun).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/usecases/__tests__/schedule-ai-route.test.ts`
Expected: FAIL — `payload.pack_units` is `undefined`, and `maybeAlertExpensiveRun` is never called (the mock import itself will also fail if `../ai-runs-admin` doesn't export `maybeAlertExpensiveRun` yet — it does after Task 1, so this test only fails on the two assertions above).

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/server/usecases/schedule-ai.ts`, add the import after `import { aiRunCostUsd } from "@/lib/ai-pricing";` (line 25):

```ts
import { maybeAlertExpensiveRun } from "@/server/usecases/ai-runs-admin";
```

In the failure branch (inside the `catch` of `aiPlanForDivision`), find:

```ts
                    cost_usd,
                    // Provider diagnostics stay server-side (ops needs the real
                    // status; the tenant gets a bare 503).
                    ...(providerErr
```

Replace with:

```ts
                    cost_usd,
                    // Size measure alongside cost (v17 gap #295 — instrument
                    // now, weight later): the fixture count the pack builder
                    // already computed, the same number already reported to
                    // PostHog as `fixtures`.
                    pack_units: movableIds.size,
                    // Provider diagnostics stay server-side (ops needs the real
                    // status; the tenant gets a bare 503).
                    ...(providerErr
```

In the success path, find:

```ts
                model,
                usage: result.usage,
                cost_usd,
                // Ladder telemetry: which model was tried first and rejected,
```

Replace with:

```ts
                model,
                usage: result.usage,
                cost_usd,
                // Size measure alongside cost (v17 gap #295): the fixture
                // count the pack builder already computed — the smallest
                // correct instrumentation ahead of any size-weighted pricing
                // decision (deferred, SPEC-2 §5.1).
                pack_units: movableIds.size,
                // Ladder telemetry: which model was tried first and rejected,
```

Then, right after the `withTenant` block that writes `schedule.ai_generated` closes (before `const officials_coverage = ...`), find:

```ts
              } as never)}, ${auth.userId})`;
  });

  const officials_coverage = input.officials_policy
```

Replace with:

```ts
              } as never)}, ${auth.userId})`;
  });

  // Expensive-run watch (v17 gap #295): best-effort, never throws, silent
  // without a baseline or STAFF_ALERT_EMAIL — see maybeAlertExpensiveRun.
  await maybeAlertExpensiveRun({
    orgId: auth.orgId,
    competitionId: gate.competitionId,
    phase: "schedule",
    model,
    costUsd: cost_usd,
  });

  const officials_coverage = input.officials_policy
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/usecases/__tests__/schedule-ai-route.test.ts`
Expected: PASS (full file — this test plus every pre-existing test in it).

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/schedule-ai.ts apps/web/src/server/usecases/__tests__/schedule-ai-route.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-runs): stamp pack_units + expensive-run check (schedule)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Wire pack_units + expensive-run alert into officials-ai.ts

**Files:**
- Modify: `apps/web/src/server/usecases/officials-ai.ts`
- Test: `apps/web/src/server/usecases/__tests__/officials-ai-route.test.ts`

**Interfaces:**
- Consumes: `maybeAlertExpensiveRun` (Task 1); `officialsAiPlanForDivision(auth, divisionId, input)` (existing, `officials-ai.ts:1023`); `pack.fixtures: PackFixture[]` (existing local, from `buildOfficialsPack`); local (unexported) `recordOfficialsRun(auth, divisionId, type, payload)` (existing, `officials-ai.ts:1176`).
- Produces: `recordOfficialsRun` now returns `Promise<string | null>` (the competition id, or `null` when the division vanished mid-run) instead of `Promise<void>` — a local, non-exported change; both of its call sites are in this same file and both are updated in this task. `competition_events` rows of type `schedule.ai_officials_generated` / `schedule.ai_failed` (officials phase) now carry `pack_units: number`.

- [ ] **Step 1: Write the failing test**

Add to `apps/web/src/server/usecases/__tests__/officials-ai-route.test.ts`. Mock block (after the existing `vi.mock("@/lib/cache", ...)`, before `import { sql } from "@/lib/db";`):

```ts
const maybeAlertExpensiveRun = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/usecases/ai-runs-admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-runs-admin")>();
  return { ...actual, maybeAlertExpensiveRun };
});
```

Add near the other local imports:

```ts
import { maybeAlertExpensiveRun as maybeAlertExpensiveRunSpy } from "../ai-runs-admin";
```

Add `maybeAlertExpensiveRun.mockClear();` to the existing `beforeEach`. Then a new `it()` inside `describe.skipIf(!HAS_DB)("officialsAiPlanForDivision — runner (v4/03 §2)", ...)`:

```ts
  it("records pack_units alongside cost, and calls the expensive-run alert check (v17 gap #295)", async () => {
    const auth = await seedPlusOrg();
    const { divisionId, fixtureIds, officialIds } = await seedOfficials(auth, {
      entrants: 3,
      officials: [{ name: "Ref A", roles: ["referee"] }],
    });
    parse.mockResolvedValueOnce(resp(assignAll(fixtureIds, officialIds[0]!)));

    await officialsAiPlanForDivision(auth, divisionId, {
      instruction: "assign",
      policy: POLICY,
      schedule: spread(fixtureIds),
    });

    const [ok] = await sql<{ payload: Record<string, unknown> }[]>`
      select payload from competition_events
      where type = 'schedule.ai_officials_generated' and payload->>'division_id' = ${divisionId}`;
    expect(ok!.payload.pack_units).toBe(fixtureIds.length);

    expect(maybeAlertExpensiveRun).toHaveBeenCalledTimes(1);
    const call = maybeAlertExpensiveRunSpy.mock.calls[0]![0] as {
      orgId: string;
      competitionId: string;
      phase: string;
      model: string;
      costUsd: number | null;
    };
    expect(call.orgId).toBe(auth.orgId);
    expect(call.phase).toBe("officials");
    expect(call.competitionId).toBeTruthy();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/usecases/__tests__/officials-ai-route.test.ts`
Expected: FAIL — `payload.pack_units` is `undefined`; `maybeAlertExpensiveRun` never called.

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/server/usecases/officials-ai.ts`, add the import after `import { aiRunCostUsd } from "@/lib/ai-pricing";`:

```ts
import { maybeAlertExpensiveRun } from "@/server/usecases/ai-runs-admin";
```

Update the failure-branch call (inside the `catch` of `officialsAiPlanForDivision`), find:

```ts
          repair_rounds: usage.repair_rounds ?? 0,
        },
        cost_usd,
      });
```

Replace with:

```ts
          repair_rounds: usage.repair_rounds ?? 0,
        },
        cost_usd,
        // Size measure alongside cost (v17 gap #295 — instrument now, weight
        // later): the fixture count the pack builder already computed, the
        // same number already reported to PostHog as `fixtures`.
        pack_units: pack.fixtures.length,
      });
```

Update the success call, find:

```ts
  const cost_usd =
    result.usage.cost_usd ?? aiRunCostUsd(model, result.usage.input_tokens, result.usage.output_tokens);
  await recordOfficialsRun(auth, divisionId, "schedule.ai_officials_generated", {
    division_id: divisionId,
    phase: "officials",
    outcome: "ok",
    model: usedModel,
    usage: result.usage,
    cost_usd,
    // Ladder telemetry: the first rung tried and the full ordered chain, when a
    // fallback happened (model above is only the winner).
    ...(result.escalated_from
      ? { escalated_from: result.escalated_from, rungs_tried: result.rungs_tried }
      : {}),
  });
```

Replace with:

```ts
  const cost_usd =
    result.usage.cost_usd ?? aiRunCostUsd(model, result.usage.input_tokens, result.usage.output_tokens);
  const competitionId = await recordOfficialsRun(auth, divisionId, "schedule.ai_officials_generated", {
    division_id: divisionId,
    phase: "officials",
    outcome: "ok",
    model: usedModel,
    usage: result.usage,
    cost_usd,
    // Size measure alongside cost (v17 gap #295): the fixture count the pack
    // builder already computed — the smallest correct instrumentation ahead
    // of any size-weighted pricing decision (deferred, SPEC-2 §5.1).
    pack_units: pack.fixtures.length,
    // Ladder telemetry: the first rung tried and the full ordered chain, when a
    // fallback happened (model above is only the winner).
    ...(result.escalated_from
      ? { escalated_from: result.escalated_from, rungs_tried: result.rungs_tried }
      : {}),
  });
  // Expensive-run watch (v17 gap #295): best-effort, never throws, silent
  // without a baseline or STAFF_ALERT_EMAIL — see maybeAlertExpensiveRun.
  // Skipped (no competitionId) only if the division vanished mid-run, in
  // which case recordOfficialsRun already recorded nothing either.
  if (competitionId) {
    await maybeAlertExpensiveRun({
      orgId: auth.orgId,
      competitionId,
      phase: "officials",
      model: usedModel,
      costUsd: cost_usd,
    });
  }
```

Update `recordOfficialsRun`'s definition, find:

```ts
/** Append one officials architect run to the competition audit ledger. Own
 *  event types ('schedule.ai_officials_generated' / 'schedule.ai_failed') —
 *  the Phase A quota counts 'schedule.ai_generated' only, so nothing here can
 *  ever consume a schedule generation. */
async function recordOfficialsRun(
  auth: AuthCtx,
  divisionId: string,
  type: "schedule.ai_officials_generated" | "schedule.ai_failed",
  payload: Record<string, unknown>,
): Promise<void> {
  await withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) return; // division vanished mid-run — nothing to ledger
    await tx`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${division.competition_id}, ${auth.orgId}, ${type},
              ${tx.json(payload as never)}, ${auth.userId})`;
  });
}
```

Replace with:

```ts
/** Append one officials architect run to the competition audit ledger. Own
 *  event types ('schedule.ai_officials_generated' / 'schedule.ai_failed') —
 *  the Phase A quota counts 'schedule.ai_generated' only, so nothing here can
 *  ever consume a schedule generation. Returns the competition id (so the
 *  success call site can feed it to maybeAlertExpensiveRun, v17 gap #295),
 *  or null when the division vanished mid-run and nothing was recorded. */
async function recordOfficialsRun(
  auth: AuthCtx,
  divisionId: string,
  type: "schedule.ai_officials_generated" | "schedule.ai_failed",
  payload: Record<string, unknown>,
): Promise<string | null> {
  return withTenant(auth.orgId, async (tx) => {
    const [division] = await tx<{ competition_id: string }[]>`
      select competition_id from divisions where id = ${divisionId}`;
    if (!division) return null; // division vanished mid-run — nothing to ledger
    await tx`
      insert into competition_events (competition_id, org_id, type, payload, actor_id)
      values (${division.competition_id}, ${auth.orgId}, ${type},
              ${tx.json(payload as never)}, ${auth.userId})`;
    return division.competition_id;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/usecases/__tests__/officials-ai-route.test.ts`
Expected: PASS (full file).

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/officials-ai.ts apps/web/src/server/usecases/__tests__/officials-ai-route.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-runs): stamp pack_units + expensive-run check (officials)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Credits-sold-vs-COGS admin panel on /admin/revenue

**Files:**
- Modify: `apps/web/src/server/usecases/ai-runs-admin.ts`
- Modify: `apps/web/src/app/admin/revenue/page.tsx`
- Test: `apps/web/src/server/usecases/__tests__/ai-margin-report.test.ts` (new)

**Interfaces:**
- Consumes: `AI_RUN_EVENT_TYPES` (existing, `ai-runs-admin.ts:8`); `sql` from `@/lib/db`; `requireStaff` (existing, `@/lib/admin`, used unchanged in `page.tsx`).
- Produces: `aiMarginReport(days: number): Promise<AiMarginReport>` exported from `ai-runs-admin.ts`, where `AiMarginReport = { days: number; aggregate: AiMarginRow; byOrg: AiMarginRow[] }` and `AiMarginRow = { org_id: string | null; org_name: string; credits_spent: number; revenue_usd: number; cogs_usd: number; margin_pct: number | null }`.
- **Design constraint (see the Migration note at the top of this file):** `ai_credit_ledger` and `competition_events` have no shared run id to join on — `credits_spent`/`revenue_usd` come from `ai_credit_ledger` (grouped by `spent_by_org_id`), `cogs_usd` comes from `competition_events` (grouped by `org_id`), and the two are combined by org id in application code, not a SQL join. This is stated explicitly in the panel's own copy so nobody mistakes it for a reconciled per-run figure.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/usecases/__tests__/ai-margin-report.test.ts`:

```ts
// v17 gap #295 — SPEC-2 §5.3's "live margin monitor" / SPEC-3 §6's
// "/admin/revenue — add credits sold vs COGS". credits_spent (and its
// $0.25/credit revenue-equivalent) comes from ai_credit_ledger; cogs_usd
// comes from the AI run audit trail (competition_events) — see the plan's
// Migration note for why these are two independent aggregates, not a
// per-run join. Real Postgres required; skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { aiMarginReport } from "../ai-runs-admin";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedOrg(name: string): Promise<string> {
  const [org] = await sql<{ id: string }[]>`
    insert into organizations (name, slug) values (${name}, ${`margin-${uniq()}`})
    returning id`;
  return org!.id;
}

async function seedCompetition(orgId: string): Promise<string> {
  const [comp] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, branding)
    values (${orgId}, 'Margin Comp', ${`margin-comp-${uniq()}`}, 'private', '{}')
    returning id`;
  return comp!.id;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe.skipIf(!HAS_DB)("aiMarginReport (v17 gap #295)", () => {
  it("nets refunds into credits_spent, prices at $0.25/credit, and rolls up per-org + aggregate", async () => {
    const orgId = await seedOrg(`Margin A ${uniq()}`);
    const compId = await seedCompetition(orgId);
    const walletId = randomUUID(); // wallet mechanics are irrelevant here — the report groups by spent_by_org_id/org_id, not wallet_id

    // 10 credits spent, 2 refunded back -> net 8 -> revenue = 8 * $0.25 = $2.00
    const holdId = randomUUID();
    await sql`
      insert into ai_credit_ledger (id, wallet_id, delta, source, bucket, spent_by_org_id, balance_after, idempotency_key)
      values (${holdId}, ${walletId}, -10, 'run_spend', 'grant', ${orgId}, 0, ${`h-${uniq()}`})`;
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, ref, balance_after, idempotency_key)
      values (${walletId}, 2, 'refund', 'grant', ${holdId}, 2, ${`r-${uniq()}`})`;

    // $0.30 real COGS across two events (one success, one failure — both count).
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${compId}, ${orgId}, 'schedule.ai_generated', ${sql.json({ cost_usd: 0.2 })})`;
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${compId}, ${orgId}, 'schedule.ai_failed', ${sql.json({ cost_usd: 0.1 })})`;

    const report = await aiMarginReport(30);
    const row = report.byOrg.find((r) => r.org_id === orgId);
    expect(row).toBeDefined();
    expect(row!.credits_spent).toBe(8);
    expect(row!.revenue_usd).toBeCloseTo(2.0, 2);
    expect(row!.cogs_usd).toBeCloseTo(0.3, 2);
    expect(row!.margin_pct).toBeCloseTo(85, 0); // (2.00 - 0.30) / 2.00 = 85%

    // Aggregate includes at least this org's numbers (other concurrent test
    // data may also be present — assert a floor, not an exact total).
    expect(report.aggregate.credits_spent).toBeGreaterThanOrEqual(8);
    expect(report.aggregate.cogs_usd).toBeGreaterThanOrEqual(0.3 - 0.001);
  });

  it("an org with COGS but no net credit spend shows margin_pct null, not a divide-by-zero", async () => {
    const orgId = await seedOrg(`Margin B ${uniq()}`);
    const compId = await seedCompetition(orgId);
    // Every run failed and was fully refunded -> net credits_spent = 0.
    const holdId = randomUUID();
    await sql`
      insert into ai_credit_ledger (id, wallet_id, delta, source, bucket, spent_by_org_id, balance_after, idempotency_key)
      values (${holdId}, ${randomUUID()}, -1, 'run_spend', 'grant', ${orgId}, 0, ${`h-${uniq()}`})`;
    await sql`
      insert into ai_credit_ledger (wallet_id, delta, source, bucket, ref, balance_after, idempotency_key)
      values ((select wallet_id from ai_credit_ledger where id = ${holdId}), 1, 'refund', 'grant', ${holdId}, 1, ${`r-${uniq()}`})`;
    await sql`
      insert into competition_events (competition_id, org_id, type, payload)
      values (${compId}, ${orgId}, 'schedule.ai_failed', ${sql.json({ cost_usd: 0.05 })})`;

    const report = await aiMarginReport(30);
    const row = report.byOrg.find((r) => r.org_id === orgId);
    expect(row).toBeDefined();
    expect(row!.credits_spent).toBe(0);
    expect(row!.revenue_usd).toBe(0);
    expect(row!.cogs_usd).toBeCloseTo(0.05, 2);
    expect(row!.margin_pct).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/usecases/__tests__/ai-margin-report.test.ts`
Expected: FAIL — `aiMarginReport` is not exported from `../ai-runs-admin`.

- [ ] **Step 3: Write minimal implementation**

Append to `apps/web/src/server/usecases/ai-runs-admin.ts` (after Task 1's additions):

```ts

/** SPEC-2 §6 base list price — the revenue-equivalent this report prices
 *  net credit spend at. Tunable dial (README §7 style); not read from
 *  stripe-plans.json because the packs price in bonus-scaled tiers, and
 *  this report is about the FLOOR price every credit is worth, not what any
 *  one purchase actually paid. */
const CREDIT_LIST_PRICE_USD = 0.25;

export interface AiMarginRow {
  org_id: string | null;
  org_name: string;
  /** Net credits consumed (run_spend, netted against their own refunds) in
   *  the window — the same derive `spentThisPeriodByOrg` uses, generalized
   *  across every org instead of one. */
  credits_spent: number;
  /** credits_spent priced at CREDIT_LIST_PRICE_USD — the "credits sold" side
   *  of the margin monitor (SPEC-2 §5.3 / SPEC-3 §6). */
  revenue_usd: number;
  /** Real $ COGS from the AI run audit trail in the same window — see the
   *  plan's Migration note for why this is an independent aggregate, not a
   *  per-run join against credits_spent. */
  cogs_usd: number;
  /** null when revenue_usd is 0 (nothing sold/spent yet) rather than a
   *  divide-by-zero or a misleading 0%/100%. */
  margin_pct: number | null;
}

export interface AiMarginReport {
  days: number;
  aggregate: AiMarginRow;
  byOrg: AiMarginRow[];
}

function marginRow(orgId: string | null, orgName: string, creditsSpent: number, cogsUsdRaw: number): AiMarginRow {
  const revenueUsd = Math.round(creditsSpent * CREDIT_LIST_PRICE_USD * 100) / 100;
  const cogsUsd = Math.round(cogsUsdRaw * 100) / 100;
  const marginPct = revenueUsd > 0 ? Math.round(((revenueUsd - cogsUsd) / revenueUsd) * 1000) / 10 : null;
  return { org_id: orgId, org_name: orgName, credits_spent: creditsSpent, revenue_usd: revenueUsd, cogs_usd: cogsUsd, margin_pct: marginPct };
}

/**
 * Credits sold vs COGS consumed, per org and aggregate (v17 gap #295,
 * SPEC-2 §5.3's "live margin monitor", SPEC-3 §6's "/admin/revenue — add
 * credits sold vs COGS"). `credits_spent` nets refunds the same way
 * `spentThisPeriodByOrg` (`lib/credits.ts:803`) does for one org, generalized
 * to a GROUP BY across every org that spent in the window. `cogs_usd` sums
 * `cost_usd` off every AI run event (success AND failure — a failed run
 * still burns real tokens) in the same window. The two are independent
 * aggregates joined by org id in JS, not a SQL join — see this file's
 * top-of-plan Migration note for why no shared run id exists to join on.
 */
export async function aiMarginReport(days: number): Promise<AiMarginReport> {
  const creditRows = await sql<{ org_id: string | null; credits_spent: string }[]>`
    select h.spent_by_org_id as org_id,
           coalesce(sum(-h.delta - coalesce((
             select sum(r.delta) from ai_credit_ledger r
              where r.source = 'refund' and r.ref = h.id::text
           ), 0)), 0)::text as credits_spent
      from ai_credit_ledger h
     where h.source = 'run_spend'
       and h.created_at >= now() - make_interval(days => ${days})
     group by h.spent_by_org_id`;

  const cogsRows = await sql<{ org_id: string | null; cogs_usd: string | null }[]>`
    select org_id, coalesce(sum((payload->>'cost_usd')::numeric), 0)::text as cogs_usd
      from competition_events
     where type = any(${AI_RUN_EVENT_TYPES as unknown as string[]})
       and created_at >= now() - make_interval(days => ${days})
     group by org_id`;

  const orgIds = new Set<string>();
  for (const r of creditRows) if (r.org_id) orgIds.add(r.org_id);
  for (const r of cogsRows) if (r.org_id) orgIds.add(r.org_id);

  const names = orgIds.size
    ? await sql<{ id: string; name: string }[]>`select id, name from organizations where id in ${sql([...orgIds])}`
    : [];
  const nameById = new Map(names.map((n) => [n.id, n.name]));
  const creditsByOrg = new Map(creditRows.map((r) => [r.org_id, Number(r.credits_spent)]));
  const cogsByOrg = new Map(cogsRows.map((r) => [r.org_id, Number(r.cogs_usd ?? 0)]));

  const byOrg = [...orgIds]
    .map((orgId) => marginRow(orgId, nameById.get(orgId) ?? "Unknown org", creditsByOrg.get(orgId) ?? 0, cogsByOrg.get(orgId) ?? 0))
    .sort((a, b) => b.cogs_usd - a.cogs_usd);

  const totalCredits = byOrg.reduce((s, r) => s + r.credits_spent, 0);
  const totalCogs = byOrg.reduce((s, r) => s + r.cogs_usd, 0);

  return { days, aggregate: marginRow(null, "All orgs", totalCredits, totalCogs), byOrg };
}
```

In `apps/web/src/app/admin/revenue/page.tsx`, replace the full file with:

```tsx
import { requireStaff, logStaffAction } from "@/lib/admin";
import { AdminRevenue } from "@/components/admin-revenue";
import { aiMarginReport, type AiMarginReport } from "@/server/usecases/ai-runs-admin";

export const dynamic = "force-dynamic";

function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}
function pct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(0)}%`;
}

/** Credits sold vs COGS consumed (v17 gap #295, SPEC-2 §5.3 "live margin
 *  monitor" / SPEC-3 §6). "Credits sold" is net credit spend priced at the
 *  $0.25 list rate, not what any one pack actually paid; "COGS" comes from
 *  the AI run audit trail. The two are independent aggregates (see the
 *  usecase's own docstring) — the copy below says so, not a reconciled
 *  per-run figure. */
function AiMarginSection({ margin }: { margin: AiMarginReport }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-white">AI credit margin — last {margin.days} days</h2>
        <p className="mt-1 text-xs text-slate-500">
          Credits sold (net credit spend at the $0.25 list price) vs COGS actually incurred (v17 gap #295) —
          the two totals come from separate ledgers (the credit wallet vs the AI run audit trail) and are not
          a per-run reconciliation.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg bg-slate-800 p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">Credits sold</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-white">{money(margin.aggregate.revenue_usd)}</div>
        </div>
        <div className="rounded-lg bg-slate-800 p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">COGS consumed</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-200">{money(margin.aggregate.cogs_usd)}</div>
        </div>
        <div className="rounded-lg bg-slate-800 p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">Margin</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-200">{pct(margin.aggregate.margin_pct)}</div>
        </div>
        <div className="rounded-lg bg-slate-800 p-4">
          <div className="text-xs uppercase tracking-wider text-slate-400">Credits spent</div>
          <div className="mt-1 text-2xl font-bold tabular-nums text-slate-200">{margin.aggregate.credits_spent}</div>
        </div>
      </div>
      {margin.byOrg.length > 0 && (
        <div className="overflow-x-auto rounded-lg bg-slate-800 p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                <th className="py-1.5 pr-3 font-medium">Organisation</th>
                <th className="py-1.5 pr-3 text-right font-medium">Credits sold</th>
                <th className="py-1.5 pr-3 text-right font-medium">COGS</th>
                <th className="py-1.5 text-right font-medium">Margin</th>
              </tr>
            </thead>
            <tbody>
              {margin.byOrg.map((row) => (
                <tr key={row.org_id ?? "unknown"} className="border-t border-slate-700/60">
                  <td className="py-1.5 pr-3 text-slate-200">{row.org_name}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">{money(row.revenue_usd)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-slate-300">{money(row.cogs_usd)}</td>
                  <td className="py-1.5 text-right tabular-nums text-white">{pct(row.margin_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Platform revenue report (design/v7 PROMPT-51): Stripe application fees
 *  rolled up by month and organisation. Stripe stays the ledger — the page
 *  only reads the cached usecase through /api/admin/revenue (superadmin;
 *  the layout's staff gate lets support in, the API re-checks). Also carries
 *  the AI credit margin monitor (v17 gap #295) — a separate, server-rendered
 *  section fed by its own usecase, not the Stripe-backed API route above. */
export default async function AdminRevenuePage() {
  const staff = await requireStaff();
  // Audited on page load only (not CSV downloads, not client range
  // changes); the range mirrors the route's last-12-calendar-months default.
  const now = new Date();
  const monthStart = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 10);
  await logStaffAction(staff.id, "revenue_report_viewed", "platform", "revenue", {
    from: monthStart(-11),
    to: monthStart(1),
  });
  const margin = await aiMarginReport(30);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-white">Revenue</h1>
        <p className="mt-1 text-xs text-slate-500">
          What the platform has earned from card entry fees — application fees read straight
          from Stripe, grouped by month and organisation. Refreshes within 5 minutes.
        </p>
      </div>
      <AdminRevenue />
      <AiMarginSection margin={margin} />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/usecases/__tests__/ai-margin-report.test.ts`
Expected: PASS.

Also run `cd apps/web && npx tsc --noEmit` to confirm `page.tsx` compiles, and screenshot the page (staff login, navigate to `/admin/revenue`) at desktop and 375px per the frontend-design/Global Constraints rule — the section reuses `admin-revenue.tsx`'s existing dark palette (`bg-slate-800`, `text-slate-400/500`) so it should already read as one surface, but verify no horizontal scroll leaks outside the table's own `overflow-x-auto`.

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/ai-runs-admin.ts apps/web/src/app/admin/revenue/page.tsx apps/web/src/server/usecases/__tests__/ai-margin-report.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): credits-sold vs COGS margin panel on /admin/revenue

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Gate onboarding + referral-welcome earn on publish-with-division

**Files:**
- Modify: `apps/web/src/server/usecases/competitions.ts`
- Modify: `apps/web/src/lib/auth.ts`
- Modify: `apps/web/src/app/api/onboarding/complete/route.ts`
- Modify: `apps/web/src/lib/__tests__/referral-grants.test.ts`
- Test: `apps/web/src/server/usecases/__tests__/publish-earn-gate.test.ts` (new)

**Interfaces:**
- Consumes: `tryEarnGrant(orgId, reason, amount): Promise<number>`, `ONBOARDING_EARN`, `REFERRAL_WELCOME_EARN` (existing, `@/lib/credits`, unchanged mechanism); `withTenant`, `sql` (`@/lib/db`); `PatchCompetition`/`CompetitionStatus` (existing, `@/server/api-v1/schemas`).
- Produces: `shouldFireGrowthEarnGrants(statusChangedTo: string | null, divisionCount: number): boolean` exported from `competitions.ts` (pure, mirrors `shouldFireMadePublic`). `patchCompetition` fires the onboarding + referral-welcome earn grants exactly once a competition is published with ≥1 non-archived division; `createOrgForUser` no longer fires the referral-welcome grant at signup; `POST /api/onboarding/complete` no longer fires the onboarding grant at completion.
- **Note (re-verify before editing):** W2 (#287, prior wave) also edits `patchCompetition` — it adds an `invalidateOrgEntitlements(auth.orgId)` call on any competition write and may narrow `statusChangedTo`'s type. Re-read the current file before anchoring these edits; the surrounding code cited below (`shouldFireMadePublic` block, the `statusChangedTo`/`oldVisibility` declarations) is unlikely to move, but line numbers will have shifted. `shouldFireGrowthEarnGrants`'s `statusChangedTo: string | null` parameter accepts a narrower enum-typed string too, so it stays compatible either way.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/server/usecases/__tests__/publish-earn-gate.test.ts`:

```ts
// v17 gap #296 — the onboarding (+10) and referral-welcome (+10) earn grants
// used to fire at signup/onboarding-complete; a scripted signup could farm
// 20 free credits per email address doing nothing else. This wave moves
// both behind a cheap real-usage signal: the org PUBLISHES a competition
// with at least one (non-archived) division. shouldFireGrowthEarnGrants is
// the pure decision (mirrors shouldFireMadePublic); the rest proves the
// wiring against real Postgres. recordEarnGrant/tryEarnGrant themselves
// (idempotency, lifetime cap) are unchanged and stay covered by
// credits-earn.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition, patchCompetition, shouldFireGrowthEarnGrants } from "../competitions";
import { createDivision } from "../divisions";
import { createOrgForUser } from "@/lib/auth";
import { balance, packBalance, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

const GENERIC_CONFIG = {
  resultMode: "score",
  allowDraws: true,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
};

async function seedUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`pub-earn-${uniq()}@example.com`}, 'Publish Earn Tester', true)
    returning id`;
  return u!.id;
}

async function seedSportFixtures(): Promise<void> {
  await sql`
    insert into sports (key, name, module_version, position_catalog)
    values ('generic', 'Generic', '1.0.0', ${sql.json({ groups: [], lineup: { size: 1, benchMax: 0 } })})
    on conflict (key) do nothing`;
  await sql`
    insert into sport_variants (sport_key, key, name, config, is_system)
    values ('generic', 'score', 'Score', ${sql.json(GENERIC_CONFIG)}, true)
    on conflict do nothing`;
}

async function authFor(orgId: string, userId: string): Promise<AuthCtx> {
  return { orgId, via: "session", userId, role: "owner", keyId: null };
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("shouldFireGrowthEarnGrants (pure, v17 gap #296)", () => {
  it("fires on published + >=1 division", () => {
    expect(shouldFireGrowthEarnGrants("published", 1)).toBe(true);
    expect(shouldFireGrowthEarnGrants("published", 2)).toBe(true);
  });
  it("does not fire on published + 0 divisions", () => {
    expect(shouldFireGrowthEarnGrants("published", 0)).toBe(false);
  });
  it("does not fire on any other status, even with divisions", () => {
    expect(shouldFireGrowthEarnGrants("draft", 1)).toBe(false);
    expect(shouldFireGrowthEarnGrants("live", 1)).toBe(false);
    expect(shouldFireGrowthEarnGrants("completed", 1)).toBe(false);
  });
  it("does not fire when the patch didn't change status", () => {
    expect(shouldFireGrowthEarnGrants(null, 1)).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("publish-with-division earn gate — wiring (v17 gap #296)", () => {
  it("an org that signs up and does nothing receives no earn_grant rows", async () => {
    const org = await createOrgForUser(await seedUser(), `Idle Org ${uniq()}`);
    const walletId = await walletIdFor(org.id);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_credit_ledger where wallet_id = ${walletId} and source = 'earn_grant'`;
    expect(n).toBe(0);
  });

  it("a referred org gets NO welcome grant at signup (moved off createOrgForUser)", async () => {
    const referrer = await createOrgForUser(await seedUser(), `Referrer ${uniq()}`);
    const org = await createOrgForUser(await seedUser(), `Referred ${uniq()}`, { referredByOrgId: referrer.id });
    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0);
  });

  it("publishing a competition with a division grants ONBOARDING_EARN once, idempotent across re-publishes", async () => {
    await seedSportFixtures();
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `Publisher ${uniq()}`);
    const auth = await authFor(org.id, userId);
    const comp = await createCompetition(auth, { name: "Cup", visibility: "private", branding: {} });
    await createDivision(auth, comp.id, {
      name: "Open",
      slug: `open-${uniq()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });

    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0); // nothing yet — still draft

    await patchCompetition(auth, comp.id, { status: "published" });
    expect(await packBalance(walletId)).toBe(10); // ONBOARDING_EARN

    // Re-publishing (idempotent per-org key) and publishing a SECOND
    // competition with a division both no-op — once per org, not per comp.
    await patchCompetition(auth, comp.id, { status: "published" });
    const comp2 = await createCompetition(auth, { name: "Cup 2", visibility: "private", branding: {} });
    await createDivision(auth, comp2.id, {
      name: "Open",
      slug: `open2-${uniq()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await patchCompetition(auth, comp2.id, { status: "published" });
    expect(await packBalance(walletId)).toBe(10);
  });

  it("publishing WITHOUT a division grants nothing", async () => {
    await seedSportFixtures();
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `No Division ${uniq()}`);
    const auth = await authFor(org.id, userId);
    const comp = await createCompetition(auth, { name: "Empty Cup", visibility: "private", branding: {} });

    await patchCompetition(auth, comp.id, { status: "published" });
    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0);
  });

  it("a referred org ALSO gets the welcome grant, but only once it publishes with a division", async () => {
    await seedSportFixtures();
    const referrerUserId = await seedUser();
    const referrer = await createOrgForUser(referrerUserId, `Referrer2 ${uniq()}`);
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `Referred2 ${uniq()}`, { referredByOrgId: referrer.id });
    const auth = await authFor(org.id, userId);
    const comp = await createCompetition(auth, { name: "Cup", visibility: "private", branding: {} });
    await createDivision(auth, comp.id, {
      name: "Open",
      slug: `open-${uniq()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });

    await patchCompetition(auth, comp.id, { status: "published" });
    const walletId = await walletIdFor(org.id);
    // ONBOARDING_EARN (10) + REFERRAL_WELCOME_EARN (10) = 20.
    expect(await balance(walletId)).toBe(20);
  });

  it("archiving every division before publish means no grant (0 non-archived divisions)", async () => {
    await seedSportFixtures();
    const userId = await seedUser();
    const org = await createOrgForUser(userId, `Archived Div ${uniq()}`);
    const auth = await authFor(org.id, userId);
    const comp = await createCompetition(auth, { name: "Cup", visibility: "private", branding: {} });
    const division = await createDivision(auth, comp.id, {
      name: "Open",
      slug: `open-${uniq()}`,
      sport_key: "generic",
      variant_key: "score",
      config: GENERIC_CONFIG,
      eligibility: [],
    });
    await sql`update divisions set archived_at = now() where id = ${division.id}`;

    await patchCompetition(auth, comp.id, { status: "published" });
    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/usecases/__tests__/publish-earn-gate.test.ts`
Expected: FAIL — `shouldFireGrowthEarnGrants` is not exported from `../competitions`; and (once that's stubbed) the wiring tests fail because `createOrgForUser` still grants the referral welcome immediately and `patchCompetition` never grants anything.

Also update `apps/web/src/lib/__tests__/referral-grants.test.ts` NOW (same step — its old assertions describe the behavior this task removes, so they must change to describe the NEW behavior before Step 3, and they must fail first). Replace its full body (the file's top comment through the end) with:

```ts
// v17 gap #296 — the new-org "welcome" earn grant used to fire immediately
// from createOrgForUser when the org was created via a referral link
// (opts.referredByOrgId). It now fires ONLY once the referred org publishes
// a competition with a division (see publish-earn-gate.test.ts for the full
// wiring) — createOrgForUser's job is reduced to stamping referred_by_org_id
// (T2) so that later signal can find it. This file now proves the NEGATIVE:
// referral stamping still happens, but the grant does not fire here anymore.
// Real Postgres required; skipped without DATABASE_URL.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { createOrgForUser } from "@/lib/auth";
import { packBalance, walletIdFor } from "@/lib/credits";

const HAS_DB = !!process.env.DATABASE_URL;

async function seedUser(): Promise<string> {
  const [u] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified)
    values (${`ref-t3-${randomUUID().slice(0, 8)}@example.com`}, 'Ref T3 Tester', true)
    returning id`;
  return u!.id;
}

describe.skipIf(!HAS_DB)("createOrgForUser referral stamping (#267 T2, grant moved by v17 gap #296)", () => {
  it("opts.referredByOrgId stamps referred_by_org_id but grants NOTHING at creation", async () => {
    const referrer = await createOrgForUser(await seedUser(), "Referrer Co " + randomUUID().slice(0, 6));
    const org = await createOrgForUser(await seedUser(), "Referred Co " + randomUUID().slice(0, 6), {
      referredByOrgId: referrer.id,
    });

    const [row] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${org.id}`;
    expect(row?.referred_by_org_id).toBe(referrer.id);

    const walletId = await walletIdFor(org.id);
    expect(await packBalance(walletId)).toBe(0);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from ai_credit_ledger
       where wallet_id = ${walletId} and idempotency_key = ${`earn:referral_welcome:${org.id}`}`;
    expect(n).toBe(0);
  });

  it("no referredByOrgId -> no stamp, no grant (existing callers unchanged)", async () => {
    const org = await createOrgForUser(await seedUser(), "Standalone Co " + randomUUID().slice(0, 6));
    const [row] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${org.id}`;
    expect(row?.referred_by_org_id).toBeNull();
  });
});
```

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/server/usecases/competitions.ts`, add to the import block. Find:

```ts
import { withTenant } from "@/lib/db";
```

Replace with:

```ts
import { sql, withTenant } from "@/lib/db";
```

Find:

```ts
import { fireDiscoveryRevalidate, invalidateDiscoveryCache } from "@/server/public-site/revalidate";
```

Add right after it:

```ts
import { ONBOARDING_EARN, REFERRAL_WELCOME_EARN, tryEarnGrant } from "@/lib/credits";
```

Find the `shouldFireMadePublic` function and add the new pure helper right after it:

```ts
export function shouldFireMadePublic(
  oldVisibility: string | null | undefined,
  newVisibility: string | null | undefined,
): boolean {
  return newVisibility === "public" && oldVisibility !== "public";
}
```

becomes:

```ts
export function shouldFireMadePublic(
  oldVisibility: string | null | undefined,
  newVisibility: string | null | undefined,
): boolean {
  return newVisibility === "public" && oldVisibility !== "public";
}

// Growth-loop gate (SPEC-5 §2, v17 gap #296): true only on the transition
// INTO "published" with at least one (non-archived) division on the
// competition — the cheapest signal that a human is running a real
// competition, not a scripted signup. Pure so it's unit-testable without a
// DB, mirroring shouldFireMadePublic above.
export function shouldFireGrowthEarnGrants(
  statusChangedTo: string | null,
  divisionCount: number,
): boolean {
  return statusChangedTo === "published" && divisionCount >= 1;
}
```

In `patchCompetition`, find:

```ts
  let statusChangedTo: string | null = null;
  let previousSlug: string | null = null;
  let oldVisibility: string | null = null;
```

Replace with:

```ts
  let statusChangedTo: string | null = null;
  let previousSlug: string | null = null;
  let oldVisibility: string | null = null;
  let publishedDivisionCount = 0;
```

Find:

```ts
    if (patch.status && patch.status !== before.status) statusChangedTo = patch.status;
    oldVisibility = before.visibility;
```

Replace with:

```ts
    if (patch.status && patch.status !== before.status) statusChangedTo = patch.status;
    oldVisibility = before.visibility;
    // Growth-loop gate (SPEC-5 §2, v17 gap #296): count divisions here, in
    // the same tenant tx, only when the patch might trigger the earn grants
    // below — avoids a division-count query on every unrelated patch.
    if (statusChangedTo === "published") {
      const [{ n }] = await tx<{ n: number }[]>`
        select count(*)::int as n from divisions
        where competition_id = ${id} and archived_at is null`;
      publishedDivisionCount = n;
    }
```

Find the end of the function (the activation-funnel block and its `return row;`):

```ts
  if (shouldFireMadePublic(oldVisibility, patch.visibility)) {
    await captureServer({
      event: EVENTS.COMPETITION_MADE_PUBLIC,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: { competition_id: id },
    });
  }
  return row;
}
```

Replace with:

```ts
  if (shouldFireMadePublic(oldVisibility, patch.visibility)) {
    await captureServer({
      event: EVENTS.COMPETITION_MADE_PUBLIC,
      distinctId: auth.userId ?? `org:${auth.orgId}`,
      orgId: auth.orgId,
      properties: { competition_id: id },
    });
  }
  // Growth-loop gate (SPEC-5 §2, v17 gap #296): onboarding + referral-welcome
  // earn credits pay out only once this org proves a human is running a real
  // competition — publishing one with at least one (non-archived) division —
  // never at signup or onboarding-complete alone (moved off auth.ts's
  // createOrgForUser and api/onboarding/complete/route.ts). Both grants are
  // idempotent per org (tryEarnGrant never throws), so re-publishing, or
  // publishing a second/third competition, is always a safe no-op.
  if (shouldFireGrowthEarnGrants(statusChangedTo, publishedDivisionCount)) {
    await tryEarnGrant(auth.orgId, "onboarding", ONBOARDING_EARN);
    const [orgRow] = await sql<{ referred_by_org_id: string | null }[]>`
      select referred_by_org_id from organizations where id = ${auth.orgId}`;
    if (orgRow?.referred_by_org_id) {
      await tryEarnGrant(auth.orgId, "referral_welcome", REFERRAL_WELCOME_EARN);
    }
  }
  return row;
}
```

In `apps/web/src/lib/auth.ts`, find the import:

```ts
import { grantMonthly, recordEarnGrant, REFERRAL_WELCOME_EARN, walletIdFor } from "@/lib/credits";
```

Replace with:

```ts
import { grantMonthly, walletIdFor } from "@/lib/credits";
```

Find:

```ts
  // Growth loop (SPEC-5 §2): an org that signed up via a referral link earns a
  // welcome credit grant. Best-effort + idempotent per org (ref = org.id), so a
  // grant hiccup never blocks org creation and a retry never double-grants.
  if (opts?.referredByOrgId) {
    try {
      const walletId = await walletIdFor(org.id);
      await recordEarnGrant(walletId, org.id, "referral_welcome", org.id, REFERRAL_WELCOME_EARN);
    } catch (err) {
      console.error(`[credits] referral welcome grant failed for org ${org.id}`, err);
    }
  }

  await invalidateUserOrgs(userId);
```

Replace with:

```ts
  // Growth-loop welcome credit (SPEC-5 §2) used to fire HERE, immediately on
  // signup-via-referral — moved by v17 gap #296 to only pay out once the
  // referred org publishes a competition with a division
  // (server/usecases/competitions.ts's patchCompetition,
  // shouldFireGrowthEarnGrants). referred_by_org_id is still stamped on the
  // insert above (#267 T2) so that later signal can find the referrer.

  await invalidateUserOrgs(userId);
```

In `apps/web/src/app/api/onboarding/complete/route.ts`, replace the full file with:

```ts
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { markOnboardingDone } from "@/lib/activation";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await markOnboardingDone(user.id);
  // The onboarding-completion earn credit (SPEC-5 §2) used to fire HERE —
  // moved by v17 gap #296 to only pay out once the org publishes a
  // competition with a division (server/usecases/competitions.ts's
  // patchCompetition, shouldFireGrowthEarnGrants). Completing onboarding is
  // no longer itself a credit-earning event.
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```
npx vitest run src/server/usecases/__tests__/publish-earn-gate.test.ts
npx vitest run src/lib/__tests__/referral-grants.test.ts
npx vitest run src/lib/__tests__/credits-earn.test.ts
npx vitest run src/server/usecases/__tests__/registrations.test.ts
```
Expected: all PASS — `credits-earn.test.ts` and `registrations.test.ts` (the referrer's own +20, unchanged) confirm nothing about the underlying grant mechanism broke.

Also run `cd apps/web && npx tsc --noEmit` — `recordEarnGrant`/`REFERRAL_WELCOME_EARN` are no longer imported in `auth.ts`; confirm no other file in this task's diff still expects the old signature.

- [ ] **Step 5: Commit**

```
git add apps/web/src/server/usecases/competitions.ts apps/web/src/lib/auth.ts apps/web/src/app/api/onboarding/complete/route.ts apps/web/src/lib/__tests__/referral-grants.test.ts apps/web/src/server/usecases/__tests__/publish-earn-gate.test.ts
git commit -m "$(cat <<'EOF'
fix(credits): gate onboarding+referral-welcome earn on publish

Both used to pay out at signup/onboarding-complete — a scripted
signup could farm 20 free credits per email address doing nothing
else. Now they pay out only once the org publishes a competition
with a division, a cheap signal that a human is running something
real. The referrer's own +20 (first-paid-competition gated) is
unchanged.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Daily earn_grant volume alert (farm-watch backstop)

**Files:**
- Modify: `apps/web/src/lib/credits.ts`
- Modify: `apps/web/src/lib/email.ts`
- Modify: `apps/web/src/app/api/cron/billing-grant/route.ts`
- Test: `apps/web/src/lib/__tests__/earn-grant-volume-alert.test.ts` (new)

**Interfaces:**
- Consumes: `grantMonthlyForAllWallets(): Promise<{wallets: number; granted: number; failed: number}>` (existing, `credits.ts:309`, unchanged signature — W3 reworks its internals, not its shape); `sql` (`@/lib/db`); `handler`, `HttpError` (`@/lib/http`, `@/lib/errors`, existing route conventions).
- Produces: `earnGrantVolumeToday(): Promise<number>`, `EARN_GRANT_DAILY_ALERT_THRESHOLD: number`, `shouldAlertOnEarnGrantVolume(count: number, threshold?: number): boolean`, `checkEarnGrantVolumeAlert(): Promise<void>` — all exported from `credits.ts`. `sendEarnGrantVolumeAlertEmail(opts): Promise<boolean>` exported from `email.ts`. The `/api/cron/billing-grant` route (already scheduled daily by `.github/workflows/billing-grant.yml`) now also runs this check — no new cron/workflow.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/lib/__tests__/earn-grant-volume-alert.test.ts`:

```ts
// v17 gap #296 — daily earn_grant volume backstop. A farming attempt spreads
// across many throwaway orgs (each its own wallet), so this counts
// GLOBALLY across every wallet, not per-wallet — the point is to catch the
// PATTERN, not one org's total. shouldAlertOnEarnGrantVolume carries the
// threshold decision as a pure function (no DB, no flake risk from other
// suites concurrently writing earn_grant rows into the same shared schema);
// earnGrantVolumeToday and checkEarnGrantVolumeAlert are thin wiring on top,
// exercised in the "clearly over" direction only — see the file's own
// comments for why the "under threshold" direction is proven at the pure
// level instead of against a DB whose day-total this suite doesn't own.
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("@/lib/email", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/email")>();
  return { ...actual, sendEarnGrantVolumeAlertEmail: vi.fn().mockResolvedValue(true) };
});

import { sql } from "@/lib/db";
import { sendEarnGrantVolumeAlertEmail } from "@/lib/email";
import {
  EARN_GRANT_DAILY_ALERT_THRESHOLD,
  checkEarnGrantVolumeAlert,
  earnGrantVolumeToday,
  shouldAlertOnEarnGrantVolume,
} from "../credits";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);

async function seedEarnGrantRow(): Promise<void> {
  await sql`
    insert into ai_credit_ledger (wallet_id, delta, source, bucket, balance_after, idempotency_key)
    values (${randomUUID()}, 10, 'earn_grant', 'pack', 10, ${`vol-${uniq()}`})`;
}

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

afterEach(() => {
  vi.mocked(sendEarnGrantVolumeAlertEmail).mockClear();
  delete process.env.STAFF_ALERT_EMAIL;
});

describe("shouldAlertOnEarnGrantVolume (pure, v17 gap #296)", () => {
  it("false strictly below the threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD - 1)).toBe(false);
  });
  it("true at or above the threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD)).toBe(true);
    expect(shouldAlertOnEarnGrantVolume(EARN_GRANT_DAILY_ALERT_THRESHOLD + 5)).toBe(true);
  });
  it("respects a custom threshold", () => {
    expect(shouldAlertOnEarnGrantVolume(3, 5)).toBe(false);
    expect(shouldAlertOnEarnGrantVolume(5, 5)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("earnGrantVolumeToday (v17 gap #296)", () => {
  it("counts only today's earn_grant rows, across every wallet (delta-based — other suites share this table)", async () => {
    const before = await earnGrantVolumeToday();
    await seedEarnGrantRow();
    await seedEarnGrantRow();
    expect(await earnGrantVolumeToday()).toBe(before + 2);
  });
});

describe.skipIf(!HAS_DB)("checkEarnGrantVolumeAlert (v17 gap #296)", () => {
  it("alerts once today's count is clearly over the threshold", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    for (let i = 0; i < EARN_GRANT_DAILY_ALERT_THRESHOLD; i++) await seedEarnGrantRow();
    await checkEarnGrantVolumeAlert();
    expect(sendEarnGrantVolumeAlertEmail).toHaveBeenCalledTimes(1);
    const args = vi.mocked(sendEarnGrantVolumeAlertEmail).mock.calls[0]![0];
    expect(args.count).toBeGreaterThanOrEqual(EARN_GRANT_DAILY_ALERT_THRESHOLD);
    expect(args.threshold).toBe(EARN_GRANT_DAILY_ALERT_THRESHOLD);
  });

  it("no STAFF_ALERT_EMAIL configured -> no email attempted even over threshold", async () => {
    delete process.env.STAFF_ALERT_EMAIL;
    for (let i = 0; i < EARN_GRANT_DAILY_ALERT_THRESHOLD; i++) await seedEarnGrantRow();
    await checkEarnGrantVolumeAlert();
    expect(sendEarnGrantVolumeAlertEmail).not.toHaveBeenCalled();
  });

  it("never throws — a check failure is swallowed", async () => {
    process.env.STAFF_ALERT_EMAIL = "ops@seazn.test";
    vi.mocked(sendEarnGrantVolumeAlertEmail).mockRejectedValueOnce(new Error("boom"));
    for (let i = 0; i < EARN_GRANT_DAILY_ALERT_THRESHOLD; i++) await seedEarnGrantRow();
    await expect(checkEarnGrantVolumeAlert()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/__tests__/earn-grant-volume-alert.test.ts`
Expected: FAIL — none of `EARN_GRANT_DAILY_ALERT_THRESHOLD`/`checkEarnGrantVolumeAlert`/`earnGrantVolumeToday`/`shouldAlertOnEarnGrantVolume` exist on `../credits`; `sendEarnGrantVolumeAlertEmail` doesn't exist on `@/lib/email`.

- [ ] **Step 3: Write minimal implementation**

In `apps/web/src/lib/credits.ts`, add the import at the top. Find:

```ts
import { sql } from "@/lib/db";
```

Replace with:

```ts
import { sql } from "@/lib/db";
import { sendEarnGrantVolumeAlertEmail } from "@/lib/email";
```

Append to the end of the file (after `friendlyAdjustLabel`):

```ts

/**
 * Daily earn_grant volume — farm-watch backstop for the publish-with-division
 * gate (v17 gap #296). Counts EVERY `earn_grant` ledger row created today
 * (UTC), across every wallet — a farming attempt spreads across many
 * throwaway orgs (each its own wallet), so a per-wallet count would never
 * trip; only the platform-wide daily total catches the pattern.
 */
export async function earnGrantVolumeToday(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from ai_credit_ledger
     where source = 'earn_grant' and created_at >= date_trunc('day', now())`;
  return Number(row?.n ?? 0);
}

/** Tunable dial (README §7 style). Pre-launch baseline: v17 has no
 *  production traffic yet, so even generous organic daily earn activity
 *  should be well under this — raise it once real usage sets a higher
 *  organic floor. */
export const EARN_GRANT_DAILY_ALERT_THRESHOLD = 20;

/** Pure decision, split from the DB/email wiring below so it is unit
 *  testable without depending on today's real (shared-schema) count. */
export function shouldAlertOnEarnGrantVolume(
  count: number,
  threshold: number = EARN_GRANT_DAILY_ALERT_THRESHOLD,
): boolean {
  return count >= threshold;
}

/**
 * Best-effort staff alert (v17 gap #296): checks today's earn_grant volume
 * against EARN_GRANT_DAILY_ALERT_THRESHOLD and emails STAFF_ALERT_EMAIL when
 * crossed. Never throws — called from the daily billing-grant cron
 * alongside the real monthly grant sweep, and a check failure here must
 * never fail that grant. Silent (no email attempted) when STAFF_ALERT_EMAIL
 * is unset, matching every other alert in this codebase.
 */
export async function checkEarnGrantVolumeAlert(): Promise<void> {
  try {
    const count = await earnGrantVolumeToday();
    if (!shouldAlertOnEarnGrantVolume(count)) return;
    const alertTo = process.env.STAFF_ALERT_EMAIL;
    if (!alertTo) return;
    await sendEarnGrantVolumeAlertEmail({ to: alertTo, count, threshold: EARN_GRANT_DAILY_ALERT_THRESHOLD });
  } catch (err) {
    console.error("[credits] earn_grant volume alert check failed", err);
  }
}
```

Insert into `apps/web/src/lib/email.ts`, right before `export function emailConfigured(): boolean {` (after Task 1's `sendAiRunCostAlertEmail`):

```ts
export interface EarnGrantVolumeAlertEmail {
  to: string;
  count: number;
  threshold: number;
}

/** Internal staff alert (v17 gap #296 farm-watch): today's earn_grant ledger
 *  rows (onboarding + referral-welcome + referral + first_paid, pooled
 *  across every wallet) crossed the daily alert threshold — the backstop
 *  for the publish-with-division gate, in case the gate itself is being
 *  worked (many throwaway orgs each publishing one bare competition).
 *  Ops-only, no user-facing i18n (mirrors sendStuckEventsAlertEmail). Fires
 *  at most once per cron poll, not deduped across days — a persistent high
 *  day repeats the alert, which is the point. */
export async function sendEarnGrantVolumeAlertEmail(opts: EarnGrantVolumeAlertEmail): Promise<boolean> {
  const subject = `Earn-grant volume alert: ${opts.count} today (threshold ${opts.threshold})`;
  const bodyText =
    `${opts.count} earn_grant credit rows have landed today, at or above the alert threshold of ` +
    `${opts.threshold} (v17 gap #296 farm-watch — onboarding/referral-welcome earn grants gated on a ` +
    `published competition with a division). Check /admin/revenue for the AI credit margin panel and ` +
    `recent signups sharing an IP or email domain pattern; farmed accounts spend differently from real ` +
    `ones (immediately, on large runs, then never again).`;
  const html = renderEmail({
    subject,
    preheader: `${opts.count} earn grants today`,
    eyebrow: "Credits · Growth loop",
    title: "Earn-grant volume alert",
    contentHtml:
      paragraph(escapeHtml(bodyText)) +
      panel("Today", `earn_grant rows: ${opts.count}\nthreshold: ${opts.threshold}`),
    footerNote: "Automated staff alert — daily billing-grant cron (v17 gap #296).",
  });
  const text = `${bodyText}\n\nearn_grant rows today: ${opts.count} · threshold: ${opts.threshold}`;
  return send({ to: opts.to, transactional: true, subject, html, text });
}

```

In `apps/web/src/app/api/cron/billing-grant/route.ts`, find:

```ts
import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { grantMonthlyForAllWallets } from "@/lib/credits";
```

Replace with:

```ts
import { headers } from "next/headers";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { checkEarnGrantVolumeAlert, grantMonthlyForAllWallets } from "@/lib/credits";
```

Find:

```ts
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    return grantMonthlyForAllWallets();
  });
}
```

Replace with:

```ts
export async function POST() {
  return handler(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new HttpError(503, "CRON_SECRET is not configured");
    const given = (await headers()).get("x-cron-secret");
    if (given !== secret) throw new HttpError(401, "Bad cron secret");
    const result = await grantMonthlyForAllWallets();
    // Growth-loop farm-watch (v17 gap #296): the SAME daily poll also checks
    // today's earn_grant volume — no new cron/workflow, this one already
    // runs once a day (billing-grant.yml). checkEarnGrantVolumeAlert never
    // throws on its own, but the failure is caught here too so a check bug
    // can never turn into a failed grant response.
    try {
      await checkEarnGrantVolumeAlert();
    } catch (err) {
      console.error("[cron/billing-grant] earn_grant volume check failed", err);
    }
    return result;
  });
}
```

Also update the route's docstring comment (immediately above `export async function POST()`) to note the added check — find:

```ts
 *  Cron-shaped like /api/cron/billing-quantity: x-cron-secret header
 *  (CRON_SECRET env). */
```

Replace with:

```ts
 *  Cron-shaped like /api/cron/billing-quantity: x-cron-secret header
 *  (CRON_SECRET env). Also runs the earn_grant daily-volume farm-watch
 *  (v17 gap #296) — same daily poll, no separate schedule. */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/__tests__/earn-grant-volume-alert.test.ts`
Expected: PASS.

Also run `cd apps/web && npx tsc --noEmit` to confirm the route file compiles.

- [ ] **Step 5: Commit**

```
git add apps/web/src/lib/credits.ts apps/web/src/lib/email.ts apps/web/src/app/api/cron/billing-grant/route.ts apps/web/src/lib/__tests__/earn-grant-volume-alert.test.ts
git commit -m "$(cat <<'EOF'
feat(credits): daily earn_grant volume alert (farm-watch)

Rides the existing daily billing-grant cron — no new schedule.
Counts earn_grant rows platform-wide (farming spreads across many
throwaway orgs, so a per-wallet count would never trip) and emails
STAFF_ALERT_EMAIL past a tunable threshold.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Docs + copy pass — ratify never-expires, record the #296 decision, fix stale copy

**Files:**
- Modify: `design/v17-pricing-entitlements/SPEC-2-addons-and-ai-credit-wallet.md`
- Modify: `design/v17-pricing-entitlements/README.md`
- Modify: `design/v17-pricing-entitlements/SPEC-5-operator-and-credit-economy.md`
- Modify: `apps/web/content/help/billing/credits.md`
- Modify: `apps/web/src/dictionaries/en/ui.json`
- Modify: `apps/web/src/dictionaries/es/ui.json`
- Modify: `apps/web/src/dictionaries/fr/ui.json`
- Modify: `apps/web/src/dictionaries/nl/ui.json`
- Modify: `apps/web/src/components/billing-credits.tsx`
- Test: none new (docs/copy) — verification commands only, see Step 4.

**Interfaces:**
- Consumes: `billing.credits.referral.desc` (existing i18n key, all 4 locales — value changes, key does not); nothing code-level.
- Produces: no new i18n keys (existing key's value changes in all 4 locales); no code exports.

- [ ] **Step 1: Write the failing test (verification baseline)**

This task is copy/docs-only — there is no unit test to fail first. Instead, capture the CURRENT (soon-to-be-wrong) state as the "before" baseline, so Step 4 proves each change actually landed:

Run (from repo root):
```
grep -n "expire 24 months" design/v17-pricing-entitlements/SPEC-2-addons-and-ai-credit-wallet.md
grep -n "24 months" design/v17-pricing-entitlements/README.md
grep -n "they start with 10" apps/web/src/dictionaries/en/ui.json
grep -rn "start with 10\|the moment they sign up" apps/web/e2e apps/web/content/help/billing/credits.md
```
Expected: the first three each print one matching line (confirming the stale copy is still present); the fourth (e2e grep) prints nothing — confirms no e2e spec currently pins this string, so changing it is safe.

- [ ] **Step 2: Run test to verify it fails**

(Same commands as Step 1 — this IS the "failing" baseline: the greps finding the OLD text is the "test" that must flip to NOT finding it after Step 3.)

- [ ] **Step 3: Write minimal implementation**

**3a. SPEC-2 §5.4 D2 — ratify never-expires.**

In `design/v17-pricing-entitlements/SPEC-2-addons-and-ai-credit-wallet.md`, find:

```
| **D2** purchased packs | **expire 24 months** from purchase ⚠ finance/legal sign-off | bounds deferred revenue + captures breakage; long enough to feel permanent |
```

Replace with:

```
| **D2** purchased packs | **never expire** (ratified 2026-07-26, #297 — supersedes this row's original 24-month decision) | shipped copy (help/billing/credits.md, all four Stripe pack descriptions) already promised this; ratifying costs zero code. Accepted liability treatment: an unbounded deferred-revenue balance with no breakage, carried as a standing prepaid-credit liability, not amortised — revisit only if volume or a jurisdiction's rules change. The Event Pass +25 grant (V330) lands in this same never-expiring `pack` bucket and inherits the same promise. |
```

**3b. README §7 item 4 — same decision.**

In `design/v17-pricing-entitlements/README.md`, find:

```
4. **Pack expiry → 24 months** from purchase (bounds deferred-revenue liability + captures breakage; long enough to feel permanent). ⚠ **needs finance/legal sign-off** — prepaid-credit / gift-card rules vary by jurisdiction (per stripe skill + finance).
```

Replace with:

```
4. **Pack expiry → never expires** (ratified 2026-07-26, #297 — supersedes the earlier 24-month decision recorded in SPEC-2 §5.4 D2). Shipped copy (help/billing/credits.md, all four Stripe pack descriptions) already promised this and the code has no expiry job. Accepted liability treatment: an unbounded deferred-revenue balance, no breakage — carried as a standing prepaid-credit liability, not amortised. The Event Pass +25 grant (V330) lands in the same never-expiring `pack` bucket and inherits the same promise.
```

**3c. SPEC-5 §2 — record the #296 decision + fix the stale guards.**

In `design/v17-pricing-entitlements/SPEC-5-operator-and-credit-economy.md`, find:

```
## 2. Earn credits (fast-follow — move 9)

Credits as a PLG growth loop. COGS $0.12/credit but perceived $0.25 → cheap CAC.

| Source | Grant | Guard |
|---|---|---|
| Referral (referred org reaches first paid comp) | tunable (e.g. 20) | once per **referred** org; block self-referral (distinct payer/email) |
| Onboarding completion | tunable (e.g. 10) | once per org |
| First paid competition | tunable (e.g. 10) | once per org |

`source = earn_grant`, idempotent per `(wallet_id, earn_reason, ref)`; **lifetime earn cap** per wallet to bound COGS. Amounts are tunable dials.
```

Replace with:

```
## 2. Earn credits (fast-follow — move 9)

Credits as a PLG growth loop. COGS $0.12/credit but perceived $0.25 → cheap CAC.

**Decision (2026-07-26, v17 gap #296 — option 1 of 3 considered):** the day-0
grants (Community's monthly 10 + the two earn grants below) were farmable at
scale — an email address is free, and both earn grants used to pay out at
signup/onboarding-complete, before any signal a real organiser exists.
Option 2 (halve the amounts) and option 3 (a global earn budget with no
per-user gate) were rejected — the first is a dial, not a fix, and the
second degrades silently for legitimate new users once tripped. Chosen: gate
onboarding completion AND the referral welcome grant behind the org
**publishing a competition with at least one division** — the cheapest
signal that a human is running something real. The monthly 10 stays
ungated (it is the margin floor doing its job, and it is what the pricing
page promises). A daily `earn_grant` volume alert (platform-wide, not
per-wallet — farming spreads across many throwaway orgs) is the backstop.

| Source | Grant | Guard |
|---|---|---|
| Referral (referred org reaches first paid comp) | tunable (e.g. 20) | once per **referred** org; block self-referral (distinct payer/email); **unchanged by #296** — already gated on a real payment |
| Referral welcome (new org signs up via a referral link) | tunable (e.g. 10) | once per org · **gated on the org's first published competition with ≥1 division (#296, was: at signup)** |
| Onboarding completion | tunable (e.g. 10) | once per org · **gated on the org's first published competition with ≥1 division (#296, was: at onboarding-complete)** |
| First paid competition | tunable (e.g. 10) | once per org; **unchanged by #296** — already gated on a real payment |

`source = earn_grant`, idempotent per `(wallet_id, earn_reason, ref)`; **lifetime earn cap** per wallet to bound COGS. Amounts are tunable dials.
```

**3d. Verify (no edit needed) — help copy + Stripe pack descriptions already say never-expires.**

Confirm (do not edit) that `apps/web/content/help/billing/credits.md:3` ("bought packs and Event Pass credits never expire") and `:21` ("## Packs and Event Pass credits never expire") already state the ratified position, and that `apps/web/src/config/stripe-plans.json` lines 126, 139, 152, 165 (the `credits_10`/`credits_25`/`credits_50`/`credits_100` product descriptions) all already end "Purchased credits never expire." — no contradiction remains anywhere in shipped copy. Run `grep -n "never expire" apps/web/content/help/billing/credits.md apps/web/src/config/stripe-plans.json` and confirm 6 matches (2 in credits.md, 4 in stripe-plans.json).

**3e. Update the "Invite & earn credits" help section for the new gating (#296).**

In `apps/web/content/help/billing/credits.md`, find:

```
## Invite & earn credits

The Credits tab also has your **Invite & earn** card, with your own shareable link. Share it with another organiser:

- When the organisation you refer runs its **first paid competition**, **you earn 20 credits**.
- **They** start with **10 credits** the moment they sign up through your link.

Both grants land straight in the credit wallet, on top of whatever the plan already grants. Referral earnings are bounded by a lifetime cap shared with other earned-credit rewards, so a very active referrer eventually tops out — the card always shows how many organisations you've referred and how many credits you've earned so far.
```

Replace with:

```
## Invite & earn credits

The Credits tab also has your **Invite & earn** card, with your own shareable link. Share it with another organiser:

- **They** earn **10 credits** once they **publish their first competition** (with at least one division) — a welcome credit for running something real, not just for signing up.
- When that organisation goes on to run its **first paid competition**, **you earn 20 credits**.

Both grants land straight in the credit wallet, on top of whatever the plan already grants. Referral earnings are bounded by a lifetime cap shared with other earned-credit rewards, so a very active referrer eventually tops out — the card always shows how many organisations you've referred and how many credits you've earned so far.
```

**3f. Update the in-app referral card copy — all 4 locales.**

In `apps/web/src/dictionaries/en/ui.json`, find:

```
  "billing.credits.referral.desc": "Share your link. When an organisation you refer runs its first paid competition, you earn 20 credits — they start with 10.",
```

Replace with:

```
  "billing.credits.referral.desc": "Share your link. When an organisation you refer publishes its first competition, they earn 10 credits. When that competition takes its first paid entry, you earn 20.",
```

In `apps/web/src/dictionaries/es/ui.json`, find:

```
  "billing.credits.referral.desc": "Comparte tu enlace. Cuando una organización que refieras dispute su primera competición de pago, ganas 20 créditos; ella empieza con 10.",
```

Replace with:

```
  "billing.credits.referral.desc": "Comparte tu enlace. Cuando una organización que refieras publique su primera competición, gana 10 créditos. Cuando esa competición reciba su primera inscripción de pago, tú ganas 20.",
```

In `apps/web/src/dictionaries/fr/ui.json`, find:

```
  "billing.credits.referral.desc": "Partagez votre lien. Quand une organisation que vous parrainez dispute sa première compétition payante, vous gagnez 20 crédits ; elle démarre avec 10.",
```

Replace with:

```
  "billing.credits.referral.desc": "Partagez votre lien. Quand une organisation que vous parrainez publie sa première compétition, elle gagne 10 crédits. Quand cette compétition reçoit sa première inscription payante, vous gagnez 20.",
```

In `apps/web/src/dictionaries/nl/ui.json`, find:

```
  "billing.credits.referral.desc": "Deel je link. Zodra een organisatie die je aanbrengt haar eerste betaalde competitie speelt, verdien jij 20 credits — zij beginnen met 10.",
```

Replace with:

```
  "billing.credits.referral.desc": "Deel je link. Zodra een organisatie die je aanbrengt haar eerste competitie publiceert, verdient zij 10 credits. Zodra die competitie de eerste betaalde inschrijving ontvangt, verdien jij 20.",
```

**3g. Fix the stale code comment in the referral card component.**

In `apps/web/src/components/billing-credits.tsx`, find:

```tsx
    {/* Invite & earn (SPEC-5 §2, #267) — the org's shareable referral link.
        A referred org's first paid competition earns THIS org 20 credits; the
        referred org starts with 10 at signup. Same card/eyebrow idiom as the
        section above, kept separate since it's its own feature (referral
        growth loop, not the wallet itself). CopyLink is the only client
        child — it never imports `@/lib/i18n`, just `path`. */}
```

Replace with:

```tsx
    {/* Invite & earn (SPEC-5 §2, #267; gating updated by v17 gap #296) — the
        org's shareable referral link. A referred org's first paid
        competition earns THIS org 20 credits; the referred org earns its own
        10 once it publishes a competition with a division (not at signup —
        see server/usecases/competitions.ts's shouldFireGrowthEarnGrants).
        Same card/eyebrow idiom as the section above, kept separate since
        it's its own feature (referral growth loop, not the wallet itself).
        CopyLink is the only client child — it never imports `@/lib/i18n`,
        just `path`. */}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from repo root):
```
grep -n "expire 24 months" design/v17-pricing-entitlements/SPEC-2-addons-and-ai-credit-wallet.md   # expect: no match
grep -n "24 months" design/v17-pricing-entitlements/README.md                                       # expect: no match (item 4 is gone)
grep -n "they start with 10" apps/web/src/dictionaries/en/ui.json                                   # expect: no match
grep -n "never expire" apps/web/content/help/billing/credits.md apps/web/src/config/stripe-plans.json  # expect: 6 matches total
npm run i18n:check
```
Expected: the first three greps find nothing (proving the stale text is gone); the fourth confirms the 6 never-expire mentions are all still consistent; `i18n:check` passes clean (same key across all 4 locales, no orphans since no key was added or removed).

Also run `cd apps/web && npx tsc --noEmit` (the `billing-credits.tsx` comment-only change should not affect compilation) and re-confirm the e2e grep from Step 1 still finds nothing: `grep -rn "start with 10\|the moment they sign up" apps/web/e2e`.

- [ ] **Step 5: Commit**

```
git add design/v17-pricing-entitlements/SPEC-2-addons-and-ai-credit-wallet.md design/v17-pricing-entitlements/README.md design/v17-pricing-entitlements/SPEC-5-operator-and-credit-economy.md apps/web/content/help/billing/credits.md apps/web/src/dictionaries/en/ui.json apps/web/src/dictionaries/es/ui.json apps/web/src/dictionaries/fr/ui.json apps/web/src/dictionaries/nl/ui.json apps/web/src/components/billing-credits.tsx
git commit -m "$(cat <<'EOF'
docs(credits): ratify never-expires; record #296 earn-gate decision

SPEC-2 §5.4 D2 and README §7 item 4 said 24-month expiry; shipped
code and copy always said never-expires. Ratify what shipped, with
the liability treatment recorded. SPEC-5 §2 records the #296 gating
decision and fixes its now-stale guard column. Invite & Earn copy
(help + in-app, 4 locales) updated to describe the new welcome-grant
condition truthfully.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

---

## Closing checklist (before opening the PR)

- [ ] `cd apps/web && npx tsc --noEmit` clean.
- [ ] `cd apps/web && npx vitest run` — full unit suite green (not just this wave's new files; Task 5 in particular touches shared call sites in `auth.ts` and the onboarding route).
- [ ] `npm run i18n:gen-keys && npm run i18n:check` clean from repo root.
- [ ] Screenshot `/admin/revenue` (desktop + 375px) — confirm the new AI-margin section reads as one surface with the existing Stripe-revenue section, no horizontal scroll outside its own table's `overflow-x-auto`.
- [ ] Screenshot the Credits tab's "Invite & earn" card (light theme, desktop + 375px) — confirm the reworded copy fits without layout shift.
- [ ] `grep -rn "start with 10\|the moment they sign up" apps/web/e2e` — still no hits (Task 7 already checked; re-verify after all 7 tasks in case a later task's rebase touched e2e).
- [ ] `scripts/smoke.ts` — no behaviour-visible-to-smoke change in this wave (no new purchase/pay path, no new gate a Community/Pro smoke walkthrough would hit) — confirm by reading the current script's AI-run and onboarding sections before skipping this step, since "no new gate" is a judgement call the implementer should verify against the actual script, not assume from this plan.
- [ ] `/code-review` on the branch.
- [ ] Merge via PR (smoke CI only runs on PRs).
