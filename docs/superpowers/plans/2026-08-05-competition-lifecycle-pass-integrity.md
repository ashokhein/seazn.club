# Competition Lifecycle and Pass Integrity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the product offering, counting, or growing a competition that has passed the point where it may be sold an Event Pass — and close the two quota loopholes on the same seam.

**Architecture:** The pass lock is re-scoped from a property of the *purchase* to a property of the *competition*, computed unconditionally at both surfaces that judge it. A fourth client gate state (`closed`) and a fifth upgrade-page kind (`closed`) carry the "sellable: no, held: never" case that neither existing card fits. Independently, one SQL function becomes the single definition of "this division has recorded results", used by both the delete guard and the quota count so archiving can no longer refund a slot the org has spent.

**Tech Stack:** Next.js (see `node_modules/next/dist/docs/` before writing framework code — this fork differs from upstream), React 19 server/client components, TypeScript 7, Node 26, pnpm 10.34.5, Postgres + Flyway migrations, zod v4, vitest, Playwright.

## Global Constraints

- **Worktree:** `/Users/ashokhein/github/wt-pass-376`, branch `fix/pass-lock-376`. Put `cd /Users/ashokhein/github/wt-pass-376 &&` in the **same shell call** as every command — the shell cwd resets to the main checkout between calls, and a verify run launched from the wrong directory returns a false green.
- **Never `git stash` in this worktree.** The stash stack is shared with the main checkout; a no-op push+pop pops a foreign stash and leaves `package.json` unmerged.
- **Judge test runs only from JSON.** `--reporter=json --outputFile=<path>`, then read `numPassedTests` / `numFailedTests` / `numTotalTests`. A suite that fails to *collect* contributes no tests and no failures, so `numFailedTests: 0` is not green on its own. Capture exit codes with a redirect, never a pipe (`cmd > out 2>&1; echo "EXIT=$?"`).
- **Four test kinds per part** — unit, e2e (Playwright), smoke, and a regression test that fails without the change. A task is not done until all four exist and pass.
- **Every new or changed user-facing string lands in all four locales**: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`. Flat dotted keys, alphabetically-adjacent placement. `content/help/**` is the one English-only tree.
- **Two CI-only drift gates**, both run before every commit: `pnpm run openapi:gen` and `pnpm run i18n:gen-keys`, then `git status --porcelain` must be empty.
- **Mobile is not optional.** Every touched surface is verified at desktop and 375px with no horizontal page scroll; interactive targets ≥44px.
- **Assertions on Next HTML must anchor on `="`.** React serialises an omitted prop as `"$undefined"`, so a bare `data-pass-closed` probe passes in both states.
- **`grep` reports files here as `Binary file … matches`** — use `git grep -n`.
- Spec: `docs/superpowers/specs/2026-08-05-competition-lifecycle-pass-integrity-design.md`. Branch state and decisions: `.claude/pass-lifecycle-state.md`.

### Command reference

```bash
WT=/Users/ashokhein/github/wt-pass-376
SCRATCH=/private/tmp/claude-501/-Users-ashokhein-github-seazn-club/70a3d30f-f4cf-4f8a-bc76-fa384fc485ec/scratchpad

# one unit suite, judged from JSON
cd $WT && pnpm -F @seazn/web exec vitest run <relative/path.test.ts> \
  --reporter=json --outputFile=$SCRATCH/r.json > $SCRATCH/r.log 2>&1; echo "EXIT=$?"
cd $WT && node -e "const r=require('$SCRATCH/r.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"

# drift gates
cd $WT && pnpm run openapi:gen && pnpm run i18n:gen-keys && git status --porcelain

# locale parity
cd $WT && pnpm run i18n:check
```

`vitest` paths are relative to `apps/web`. The DB-backed suites need `apps/web/.env.local`, which is symlinked into this worktree already — if ~1772 tests report as `pending` with `total` unchanged, the symlink is broken, not the code.

---

## File Structure

**Part A — the pass line versus the offer surfaces**

| File | Responsibility after the change |
| --- | --- |
| `apps/web/src/lib/upgrade-page-state.ts` | Gains the `closed` kind and the precedence that keeps a locked competition out of **both** offer arms |
| `apps/web/src/components/competition-pass-provider.tsx` | `PassGateState` gains `"closed"`; `usePassGateState` resolves it |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/layout.tsx` | Judges the lock from the **competition**, via a LEFT JOIN, with or without a pass row |
| `apps/web/src/components/competition-pass-entry.tsx` | Renders the `closed` state: one editor-gated link, chosen by lock reason |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx`, `.../settings/page.tsx` | Supply the two closed-state links (the pages hold the dictionary, the island holds the verdict) |
| `apps/web/src/lib/pass-ladder.ts` | `PASS_CLOSED_REASON_KEY` — the reason→key Record that makes a third lock reason a compile error |
| `apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx` | New `ClosedPanel`; `Ticket` is type-excluded from ever seeing `closed` |
| `apps/web/src/app/api/billing/pass-checkout/route.ts` | Comment only — its stale claim that the surfaces suppress this |

**Part C — a played division keeps its quota slot**

| File | Responsibility |
| --- | --- |
| `db/migration/deltas/V354__division_slot_consumption.sql` | `division_has_results()`, its partial index, and the waiver columns |
| `apps/web/src/server/usecases/divisions.ts` | Quota count honours consumed slots; delete guard calls the same function |
| `apps/web/src/server/usecases/admin-divisions.ts` (new) | Staff waiver: clear a division's slot consumption, audited |
| `apps/web/src/app/api/admin/divisions/[id]/slot-waiver/route.ts` (new) | The staff endpoint |
| `apps/web/src/components/v2/division-danger-zone.tsx` | Warns *before* archiving that the slot will not return |

**Part D — a terminal competition accepts no new divisions**

| File | Responsibility |
| --- | --- |
| `apps/web/src/server/usecases/divisions.ts` | `assertCompetitionNotEnded` guard on create and restore |

**Part B — a mandatory, changeable end date**

| File | Responsibility |
| --- | --- |
| `apps/web/src/server/api-v1/schemas.ts` | `ends_on` required on create, non-nullable on patch, `ends_on >= starts_on` |
| `apps/web/src/components/v2/competition-wizard.tsx` | Required field + message |
| `apps/web/src/components/v2/competition-settings.tsx` | Still editable, same validation message |
| every fixture/seed that creates a competition | Carries an end date |

---

## Task order and why

**A → C → D → B.** Part B makes part A's defect reachable for *every* competition rather than only terminal ones, so A must land first or the branch briefly ships a wider defect than it started with. B is last for a second reason: it breaks every fixture that creates a competition, and doing that while other parts are still in flight would make every later test failure ambiguous.

Tasks run **sequentially** through implementer → reviewer. Tasks 3 and 4 both edit the four `ui.json` files; they must never run in parallel.

---

### Task 1: The `closed` upgrade-page state

**Files:**
- Modify: `apps/web/src/lib/upgrade-page-state.ts:40-108`
- Test: `apps/web/src/lib/__tests__/upgrade-page-state.test.ts`

**Interfaces:**
- Consumes: `PassLockReason` from `@/lib/entitlements` (already imported).
- Produces: `UpgradePageState` gains `{ kind: "closed"; reason: PassLockReason; canBuy: boolean }`. Tasks 4 and 5 depend on this exact shape.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/__tests__/upgrade-page-state.test.ts`:

```ts
describe("a competition past the pass line that never held a pass", () => {
  // #376. The offer and the API disagreed: the page rendered a checkout and
  // POST /api/billing/pass-checkout answered 410 Gone. Neither existing card
  // fits — `ended` would claim a purchase nobody made, `offer` sells a refusal.
  it("is `closed`, not `offer`, on the terminal arm", () => {
    expect(
      upgradePageState({
        paidPlan: false,
        hasPass: false,
        lockReason: "terminal",
        isOwner: true,
      }),
    ).toEqual({ kind: "closed", reason: "terminal", canBuy: true });
  });

  it("is `closed` on the past_ends_on arm, carrying the reason", () => {
    expect(
      upgradePageState({
        paidPlan: false,
        hasPass: false,
        lockReason: "past_ends_on",
        isOwner: true,
      }),
    ).toEqual({ kind: "closed", reason: "past_ends_on", canBuy: true });
  });

  it("is still `closed` for a non-owner, who simply cannot act on it", () => {
    expect(
      upgradePageState({
        paidPlan: false,
        hasPass: false,
        lockReason: "terminal",
        isOwner: false,
      }),
    ).toEqual({ kind: "closed", reason: "terminal", canBuy: false });
  });

  // The case #376 does not mention at all. A PAID org with no pass and a rung
  // that beats its plan (#327) was handed `offer{beyondPlan:true}` even for a
  // locked competition — a Buy button that 410s exactly like the community one.
  // Suppressing only the community path would have left this live.
  it("never becomes the #327 beyondPlan offer while locked", () => {
    expect(
      upgradePageState({
        paidPlan: true,
        hasPass: false,
        lockReason: "terminal",
        isOwner: true,
        exceedingRungs: ["event_pass_l"],
      }),
    ).toEqual({ kind: "paid_plan" });
  });

  it("still offers beyondPlan when the competition is NOT locked", () => {
    expect(
      upgradePageState({
        paidPlan: true,
        hasPass: false,
        lockReason: null,
        isOwner: true,
        exceedingRungs: ["event_pass_l"],
      }),
    ).toEqual({ kind: "offer", canBuy: true, beyondPlan: true });
  });

  it("leaves the HELD arms alone — a lock with a pass is still `ended`", () => {
    expect(
      upgradePageState({
        paidPlan: false,
        hasPass: true,
        lockReason: "terminal",
        isOwner: true,
      }),
    ).toEqual({ kind: "ended", reason: "terminal" });
  });

  it("is the ordinary offer when nothing is locked and no pass is held", () => {
    expect(
      upgradePageState({
        paidPlan: false,
        hasPass: false,
        lockReason: null,
        isOwner: true,
      }),
    ).toEqual({ kind: "offer", canBuy: true, beyondPlan: false });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/lib/__tests__/upgrade-page-state.test.ts --reporter=json --outputFile=/tmp/ups.json > /tmp/ups.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/ups.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: `fail` ≥ 4. The `closed` cases return `{kind:"offer",…}`; the beyondPlan case returns `{kind:"offer",beyondPlan:true}`.

- [ ] **Step 3: Add the kind to the union**

In `apps/web/src/lib/upgrade-page-state.ts`, add to `UpgradePageState` immediately before the `offer` member:

```ts
  /**
   * Past the pass line, and NO pass was ever held (#376) — *sellable: no,
   * held: never*. The fourth situation, which neither `ended` nor `offer`
   * fits: `ended` would claim a purchase nobody made, and `offer` puts a Buy
   * button on a checkout that answers 410 Gone
   * (`pass-checkout/route.ts` — `if (passLockReason(comp.status, comp.ends_on))`).
   *
   * `reason` rather than a boolean because the two arms want opposite next
   * steps, and this is the state where that matters most: `terminal` is done
   * and the organiser's move is next season, while `past_ends_on` is usually a
   * stale date on a competition still being played — fix the date and the pass
   * becomes buyable again. This state is RECOVERABLE on one arm and not the
   * other, and the copy has to say which.
   */
  | { kind: "closed"; reason: PassLockReason; canBuy: boolean }
```

- [ ] **Step 4: Implement the precedence**

Replace the body of `upgradePageState` from the `if (input.paidPlan)` line through the `if (input.hasPass) {` block's opening with:

```ts
  // The lock, but ONLY where no pass was ever held. Bound once, as a
  // `PassLockReason | null`, so both branches below narrow off the same value
  // rather than re-deriving the condition — and so the `closed` return needs
  // no non-null assertion.
  const closedToPasses = input.hasPass ? null : input.lockReason;

  if (input.paidPlan) {
    // #327's offer is subject to the line like every other offer. A paid org
    // with an exceeding rung on a FINISHED competition was being sold a pass
    // the route refuses — the same defect as the community chip, one plan tier
    // up, and absent from #376's write-up.
    if (!input.hasPass && closedToPasses === null && (input.exceedingRungs?.length ?? 0) > 0)
      return { kind: "offer", canBuy: input.isOwner, beyondPlan: true };
    return { kind: "paid_plan" };
  }
  // Before `hasPass`, and before the ordinary offer: this is the arm that used
  // to fall through to `offer` and render a checkout.
  if (closedToPasses !== null)
    return { kind: "closed", reason: closedToPasses, canBuy: input.isOwner };
  if (input.hasPass) {
```

Leave the rest of the `hasPass` block and the trailing `offer` return untouched.

- [ ] **Step 5: Update the precedence doc comment**

The block comment above `export type UpgradePageState` says "six states". Change that count to seven and add, after the paragraph beginning "A LOCKED pass wins over the ceiling":

```
 * A locked competition with NO pass wins over both offer arms (#376). The
 * route refuses the sale with 410 whatever the plan is, so a Buy button here
 * is a dead end for a community org and for a paid org holding a #327
 * exceeding rung alike. `hasPass` is what separates this from `ended`: same
 * line crossed, but nothing was ever bought, so there is no purchase to
 * report as stopped.
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/lib/__tests__/upgrade-page-state.test.ts --reporter=json --outputFile=/tmp/ups.json > /tmp/ups.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/ups.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: `fail 0`, and `total` up by exactly 7 from Step 2's run.

- [ ] **Step 7: Commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && git add apps/web/src/lib/upgrade-page-state.ts apps/web/src/lib/__tests__/upgrade-page-state.test.ts && git commit -m "fix(pass): a competition past the pass line with no pass is closed, not for sale

upgradePageState returned `offer` for a locked competition that never held
a pass, because the `ended` arm sits inside `if (input.hasPass)` (#327,
86168e45). The page therefore rendered a live checkout that POST
/api/billing/pass-checkout answers with 410 Gone.

Also covers the case #376 does not mention: a PAID org with a #327
exceeding rung got `offer{beyondPlan:true}` on a finished competition, and
that Buy button dead-ends identically."
```

---

### Task 2: The lock is a fact about the competition

**Files:**
- Modify: `apps/web/src/components/competition-pass-provider.tsx:97` (type), `:228-233` (hook), `:212-222` (comment)
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/layout.tsx:126-184`
- Test: `apps/web/src/components/__tests__/competition-pass-provider.test.tsx`
- Test: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/__tests__/competition-pass-layout.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1 (independent file).
- Produces: `PassGateState` includes `"closed"`; `passState()` returns `lockReason` for a competition with **no** pass row, and `sellableRungs: []` whenever locked. Task 3 depends on both.

- [ ] **Step 1: Write the failing provider test**

Append to `apps/web/src/components/__tests__/competition-pass-provider.test.tsx`, following the render/wrapper pattern already in that file:

```tsx
describe("usePassGateState — the closed state (#376)", () => {
  it("is `closed` when the competition is locked and no pass was held", () => {
    const { result } = renderHook(() => usePassGateState(), {
      wrapper: wrapperWith({
        passKey: null,
        paidPlan: false,
        lockReason: "terminal",
        sellableRungs: [],
      }),
    });
    expect(result.current).toBe("closed");
  });

  it("is still `none` when nothing is locked and no pass is held", () => {
    const { result } = renderHook(() => usePassGateState(), {
      wrapper: wrapperWith({
        passKey: null,
        paidPlan: false,
        lockReason: null,
        sellableRungs: ["event_pass"],
      }),
    });
    expect(result.current).toBe("none");
  });

  // A paid plan already suppresses the chip and `paid_plan` is not a lie about
  // a closed competition, so it keeps winning.
  it("yields to paid_plan", () => {
    const { result } = renderHook(() => usePassGateState(), {
      wrapper: wrapperWith({
        passKey: null,
        paidPlan: true,
        lockReason: "terminal",
        sellableRungs: [],
      }),
    });
    expect(result.current).toBe("paid_plan");
  });

  it("leaves a HELD locked pass as `ended`", () => {
    const { result } = renderHook(() => usePassGateState(), {
      wrapper: wrapperWith({
        passKey: "event_pass",
        paidPlan: false,
        lockReason: "past_ends_on",
        sellableRungs: [],
      }),
    });
    expect(result.current).toBe("ended");
  });
});
```

If `wrapperWith` does not exist in that file under that name, use whatever helper the existing tests use to mount `CompetitionPassProvider` with explicit props — do **not** invent a second helper.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/components/__tests__/competition-pass-provider.test.tsx --reporter=json --outputFile=/tmp/cpp.json > /tmp/cpp.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/cpp.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: 1 failure — the first case returns `"none"`.

- [ ] **Step 3: Widen the type and the hook**

`apps/web/src/components/competition-pass-provider.tsx:97`:

```ts
export type PassGateState = "none" | "held" | "ended" | "paid_plan" | "closed";
```

Replace `usePassGateState`:

```ts
export function usePassGateState(): PassGateState {
  const { passKey, paidPlan, lockReason } = useContext(CompetitionPassContext);
  if (paidPlan) return "paid_plan";
  // No pass row, and the competition is past the line: `closed` (#376). This
  // used to resolve `none`, which put the buy link on a purchase the route
  // refuses with 410. It is NOT `ended` — nothing was bought, so there is no
  // purchase to report as stopped, which is what the note below was right
  // about and what `closed` exists to preserve.
  if (passKey === null) return lockReason !== null ? "closed" : "none";
  return lockReason !== null ? "ended" : "held";
}
```

- [ ] **Step 4: Correct the superseded note**

The comment at `:212-222` ends with "a lock reason with no pass row stays `none` rather than inventing an ended pass for a competition that never had one." Replace that final sentence with:

```
 * Note the ORDER of the last two: `passKey` is checked before `lockReason`,
 * and a lock reason with NO pass row resolves `closed` (#376) — never `ended`,
 * which would invent a purchase for a competition that never had one, and
 * never `none`, which would put the buy link on a sale the route answers with
 * 410 Gone.
```

- [ ] **Step 5: Judge the lock from the competition, not the pass row**

In `apps/web/src/app/o/[orgSlug]/c/[compSlug]/layout.tsx`, replace the `Promise.all` block and the return of `passState` with:

```ts
  const [[row], planKey, currency] = await Promise.all([
    // LEFT JOIN, and FROM the competition (#376). The old INNER join through
    // `competition_passes` meant a competition with no pass returned no row at
    // all — so `status` and `ends_on` were never read, and the lock could not
    // be judged even in principle. The lock is a fact about the COMPETITION;
    // the pass row only decides which side of it the org is on. Same single
    // round trip.
    sql<{ pass_key: string | null; status: string; ends_on: Date | string | null }[]>`
      select cp.pass_key, c.status, c.ends_on
      from competitions c
      left join competition_passes cp on cp.competition_id = c.id
      where c.id = ${comp.id}
      limit 1`,
    orgPlanKey(org.id),
    preferredCurrency(org.id),
  ]);
  const hasPass = row?.pass_key != null;
  // Judged for every competition now, pass or no pass.
  const lockReason = row ? passLockReason(row.status, row.ends_on) : null;
  const paid = isPaidPlan(planKey);
  // Nothing is sellable past the line — the route refuses it (410), so a rung
  // column here could only ever advertise a refusal. A held pass short-circuits
  // for the older reason: one pass per competition, forever (#248 Q4).
  const sellableRungs =
    hasPass || lockReason !== null
      ? []
      : ((await sellablePassRungs(PASS_KEYS, planKey, paid)) as PassKey[]);
  const covered = paid && sellableRungs.length === 0;
  return {
    passKey: hasPass && isPassKey(row.pass_key) ? (row.pass_key as PassKey) : hasPass ? "event_pass" : null,
    paidPlan: covered,
    sellableRungs,
    currency,
    lockReason,
  };
```

Delete the now-wrong comment above the old `lockReason:` line ("No pass, no lock: the reason is about a PURCHASE…") — it documents the defect.

- [ ] **Step 6: Write the layout regression test**

Append to `apps/web/src/app/o/[orgSlug]/c/[compSlug]/__tests__/competition-pass-layout.test.tsx`, matching that file's existing mocking style:

```tsx
it("reports a lock for a competition that never held a pass (#376 regression)", async () => {
  // The whole defect in one assertion: before the LEFT JOIN this returned
  // lockReason null, because the INNER join produced no row without a pass.
  seedCompetition({ status: "completed", ends_on: null, pass: null });
  const state = await passStateForTest("riverside", "spring-2025");
  expect(state.lockReason).toBe("terminal");
  expect(state.passKey).toBeNull();
  expect(state.sellableRungs).toEqual([]);
});

it("still reports no lock for a live competition with no pass", async () => {
  seedCompetition({ status: "live", ends_on: null, pass: null });
  const state = await passStateForTest("riverside", "spring-2025");
  expect(state.lockReason).toBeNull();
  expect(state.sellableRungs.length).toBeGreaterThan(0);
});
```

If `passState` is not exported, export it for the test (`export async function passState`) and note in its doc comment that the export exists for the layout test. If the existing file drives the layout through a rendered component instead, follow that pattern and assert the provider props it receives.

- [ ] **Step 7: Run both suites**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/components/__tests__/competition-pass-provider.test.tsx "src/app/o/[orgSlug]/c/[compSlug]/__tests__/competition-pass-layout.test.tsx" --reporter=json --outputFile=/tmp/t2.json > /tmp/t2.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/t2.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests);console.log(r.testResults.map(t=>t.name).join('\n'))"
```

Expected: `fail 0`, and every printed path under `/Users/ashokhein/github/wt-pass-376/` — a path under the main checkout means the run escaped the worktree and proves nothing.

- [ ] **Step 8: Commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && git add apps/web/src/components/competition-pass-provider.tsx "apps/web/src/app/o/[orgSlug]/c/[compSlug]/layout.tsx" apps/web/src/components/__tests__/competition-pass-provider.test.tsx "apps/web/src/app/o/[orgSlug]/c/[compSlug]/__tests__/competition-pass-layout.test.tsx" && git commit -m "fix(pass): judge the pass line from the competition, not from the pass row

The layout INNER-joined competitions through competition_passes, so a
competition with no pass returned no row and its status and ends_on were
never read — passLockReason could not be called even in principle, and the
gate's passKey-before-lockReason ordering was a second layer over a value
that was already null.

LEFT JOIN from competitions, judge every competition, and add the fourth
gate state the result needs: closed — sellable no, held never."
```

---

### Task 3: The chip stops offering a refused purchase

**Files:**
- Modify: `apps/web/src/components/competition-pass-entry.tsx`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx:70-84`
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/settings/page.tsx:87-101`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json` (after line 947)
- Test: `apps/web/src/components/__tests__/competition-pass-entry.test.tsx`

**Interfaces:**
- Consumes: `PassGateState` including `"closed"` (Task 2); `usePassLockReason()` (already exported).
- Produces: `CompetitionPassEntry` gains one required prop, `closedLinks: Record<PassLockReason, { href: string; label: string }>`. Task 5's e2e selects `[data-pass-closed]` and `[data-pass-closed-link]`.

- [ ] **Step 1: Add the dictionary key to all four locales**

Insert immediately after the `"pass.entry.ended.nextEdition"` line (947) in each file:

`en/ui.json`:
```json
  "pass.entry.closed.updateEndDate": "Update the end date",
```
`es/ui.json`:
```json
  "pass.entry.closed.updateEndDate": "Actualizar la fecha de finalización",
```
`fr/ui.json`:
```json
  "pass.entry.closed.updateEndDate": "Mettre à jour la date de fin",
```
`nl/ui.json`:
```json
  "pass.entry.closed.updateEndDate": "Einddatum bijwerken",
```

Then regenerate the key union so `DictionaryKey` knows it:

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm run i18n:gen-keys && pnpm run i18n:check
```

- [ ] **Step 2: Write the failing component tests**

Append to `apps/web/src/components/__tests__/competition-pass-entry.test.tsx`, reusing that file's existing render helper:

```tsx
const closedLinks = {
  terminal: { href: "/o/riverside/c/new", label: "Create next year's edition" },
  past_ends_on: { href: "/o/riverside/c/spring/settings", label: "Update the end date" },
} as const;

describe("the closed state (#376)", () => {
  it("renders no buy chip for a locked competition that never held a pass", () => {
    renderEntry({ passKey: null, paidPlan: false, lockReason: "terminal", canBuy: true, closedLinks });
    expect(document.querySelector("[data-pass-entry]")).toBeNull();
  });

  it("points a finished competition at next season", () => {
    renderEntry({ passKey: null, paidPlan: false, lockReason: "terminal", canBuy: true, closedLinks });
    const link = document.querySelector("[data-pass-closed-link]");
    expect(link?.getAttribute("href")).toBe("/o/riverside/c/new");
    expect(link?.textContent).toContain("Create next year's edition");
  });

  // The recoverable arm. A stale end date is usually a typo on a competition
  // still being played — fix it and the pass is buyable again, so pointing
  // this organiser at NEXT season would be the wrong next step entirely.
  it("points a past-end-date competition at its settings, not at next season", () => {
    renderEntry({ passKey: null, paidPlan: false, lockReason: "past_ends_on", canBuy: true, closedLinks });
    const link = document.querySelector("[data-pass-closed-link]");
    expect(link?.getAttribute("href")).toBe("/o/riverside/c/spring/settings");
    expect(link?.textContent).toContain("Update the end date");
  });

  it("shows nothing to a viewer who cannot act on it", () => {
    renderEntry({ passKey: null, paidPlan: false, lockReason: "terminal", canBuy: false, closedLinks });
    expect(document.querySelector("[data-pass-closed]")).toBeNull();
  });

  it("says nothing about a pass, because none was ever bought", () => {
    renderEntry({ passKey: null, paidPlan: false, lockReason: "terminal", canBuy: true, closedLinks });
    expect(document.querySelector("[data-pass-ended]")).toBeNull();
    expect(document.body.textContent).not.toContain("Event Pass ended");
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/components/__tests__/competition-pass-entry.test.tsx --reporter=json --outputFile=/tmp/cpe.json > /tmp/cpe.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/cpe.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: 4 failures (the first assertion finds a `[data-pass-entry]` chip that should not be there).

- [ ] **Step 4: Add the prop and the branch**

In `apps/web/src/components/competition-pass-entry.tsx`, add to the props type after `endedReasons`:

```tsx
  /**
   * The one link the `closed` state offers, per lock reason (#376).
   *
   * A `Record<PassLockReason, …>` for the same reason `endedReasons` is one:
   * the page holds the dictionary and the routes, this island holds the
   * verdict, and a third lock reason must be a compile error at the page
   * rather than a card that silently links somewhere wrong. The two arms lead
   * to genuinely different places — a finished competition's next move is next
   * season, a stale end date's next move is the settings form — so this is a
   * Record of `{href,label}`, not a Record of labels over one href.
   */
  closedLinks: Record<PassLockReason, { href: string; label: string }>;
```

Insert the branch immediately after the `if (gate === "paid_plan") return null;` line:

```tsx
  if (gate === "closed") {
    // Editor-gated, unlike the ended card. The ended card shows to everyone
    // because it is a FACT about the competition; this state's entire content
    // is an action link, and a lone link shown to someone who cannot create a
    // competition or edit its dates is noise, not information.
    //
    // `lockReason` cannot be null here (usePassGateState returns "closed" only
    // when it is set); the guard is what keeps the Record lookup total rather
    // than an assertion.
    if (!canBuy || lockReason === null) return null;
    const link = closedLinks[lockReason];
    return (
      <p data-pass-closed data-pass-closed-reason={lockReason} className="mb-1">
        <Link
          href={link.href}
          data-pass-closed-link
          // min-h-11 is the 44px touch target; the negative margin keeps the
          // chip's optical position while the tappable box grows on mobile.
          className="-my-1 inline-flex min-h-11 items-center text-xs font-semibold text-purple-700 underline decoration-purple-300 underline-offset-2 hover:text-purple-800 hover:decoration-purple-500"
        >
          {link.label} →
        </Link>
      </p>
    );
  }
```

Also extend the file's header comment block, which enumerates the states, by adding after the `ended` entry:

```
//   closed    → the competition is past the line and NEVER held a pass (#376).
//               Not `ended` (that card reports a purchase stopping, and there
//               was no purchase) and not `none` (that one offers a sale the
//               route answers with 410 Gone). One link, chosen by reason: a
//               finished competition points at next season, a stale end date
//               points at the settings form that makes the pass buyable again.
```

- [ ] **Step 5: Pass the links from both mount sites**

In `apps/web/src/app/o/[orgSlug]/c/[compSlug]/page.tsx`, add to the `<CompetitionPassEntry …>` props, after `nextEditionLabel`:

```tsx
              closedLinks={{
                terminal: {
                  href: routes.competitionNew(orgSlug),
                  label: t(dict, "pass.entry.ended.nextEdition"),
                },
                past_ends_on: {
                  href: routes.competitionSettings(orgSlug, compSlug),
                  label: t(dict, "pass.entry.closed.updateEndDate"),
                },
              }}
```

Apply the identical block to `apps/web/src/app/o/[orgSlug]/c/[compSlug]/settings/page.tsx`. Confirm both files already have `compSlug` and `routes` in scope; if `settings/page.tsx` lacks `compSlug`, take it from the same `params` destructure the page already performs.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/components/__tests__/competition-pass-entry.test.tsx src/app/__tests__/pass-entry-points.test.ts --reporter=json --outputFile=/tmp/cpe.json > /tmp/cpe.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/cpe.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: `fail 0`. `pass-entry-points.test.ts` asserts every mount site supplies every prop — if it fails, a mount site is missing `closedLinks`.

- [ ] **Step 7: Typecheck, then commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/tc.log
cd /Users/ashokhein/github/wt-pass-376 && pnpm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-pass-376 && git add -A && git commit -m "fix(pass): the header stops offering a pass the route refuses

A competition past the pass line that never held one showed the buy chip.
It now shows a single editor-gated link chosen by lock reason: a finished
competition points at next season, a competition merely past a stale end
date points at the settings form — fixing the date puts it back before the
line and makes the pass buyable again, so next season is the wrong advice
there."
```

---

### Task 4: The upgrade page stops rendering a dead checkout

**Files:**
- Modify: `apps/web/src/lib/pass-ladder.ts` (append `PASS_CLOSED_REASON_KEY`)
- Modify: `apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx:220` (lock), `:270-275` (columns), `:384-407` (panel choice), `:480-506` (Ticket props type), plus a new `ClosedPanel`
- Modify: `apps/web/src/app/api/billing/pass-checkout/route.ts:160-164` (comment only)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/app/__tests__/pass-entry-points.test.ts`

**Interfaces:**
- Consumes: `{ kind: "closed"; reason; canBuy }` from Task 1.
- Produces: `PASS_CLOSED_REASON_KEY: Record<PassLockReason, DictionaryKey>`; the page renders `[data-pass-closed-panel]`. Task 5's e2e selects it.

- [ ] **Step 1: Add three keys to all four locales**

Insert after `"pass.entry.closed.updateEndDate"` in each file:

`en`:
```json
  "upgrade.closed.title": "This competition is closed to Event Passes",
  "upgrade.closed.reasonTerminal": "This competition is finished or archived, so an Event Pass can no longer be bought for it.",
  "upgrade.closed.reasonPastEnds": "This competition is past its end date, so an Event Pass can no longer be bought for it. Update the end date if it is still running.",
```
`es`:
```json
  "upgrade.closed.title": "Esta competición está cerrada a los Event Pass",
  "upgrade.closed.reasonTerminal": "Esta competición ha finalizado o está archivada, por lo que ya no se puede comprar un Event Pass para ella.",
  "upgrade.closed.reasonPastEnds": "Esta competición ha superado su fecha de finalización, por lo que ya no se puede comprar un Event Pass para ella. Actualiza la fecha de finalización si sigue en curso.",
```
`fr`:
```json
  "upgrade.closed.title": "Cette compétition est fermée aux Event Pass",
  "upgrade.closed.reasonTerminal": "Cette compétition est terminée ou archivée : un Event Pass ne peut plus être acheté pour elle.",
  "upgrade.closed.reasonPastEnds": "Cette compétition a dépassé sa date de fin : un Event Pass ne peut plus être acheté pour elle. Mettez à jour la date de fin si elle est toujours en cours.",
```
`nl`:
```json
  "upgrade.closed.title": "Deze competitie is gesloten voor Event Passes",
  "upgrade.closed.reasonTerminal": "Deze competitie is afgelopen of gearchiveerd, dus er kan geen Event Pass meer voor worden gekocht.",
  "upgrade.closed.reasonPastEnds": "Deze competitie is voorbij haar einddatum, dus er kan geen Event Pass meer voor worden gekocht. Werk de einddatum bij als de competitie nog loopt.",
```

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm run i18n:gen-keys && pnpm run i18n:check
```

- [ ] **Step 2: Add the reason→key Record**

Append to `apps/web/src/lib/pass-ladder.ts`, directly below `PASS_LOCK_REASON_KEY`:

```ts
/**
 * The same two reasons, said to someone who never bought a pass (#376).
 *
 * A separate Record rather than a reuse of `PASS_LOCK_REASON_KEY`: every one
 * of those sentences ends "so its Event Pass has stopped lifting its limits",
 * which is a statement about a purchase. On this state there was no purchase,
 * and the sentence would be a plain falsehood on the one screen that exists to
 * explain what the org can and cannot buy.
 *
 * Keyed off the union for the same compile-error protection.
 */
export const PASS_CLOSED_REASON_KEY: Record<PassLockReason, DictionaryKey> = {
  terminal: "upgrade.closed.reasonTerminal",
  past_ends_on: "upgrade.closed.reasonPastEnds",
};
```

- [ ] **Step 3: Compute the lock unconditionally on the page**

`apps/web/src/app/o/[orgSlug]/c/[compSlug]/upgrade/page.tsx:220` — replace:

```ts
  const lockReason = pass ? passLockReason(pass.status, pass.ends_on) : null;
```

with:

```ts
  // Judged from the COMPETITION, with or without a pass row (#376) — the same
  // correction the layout needed. `pass.status`/`pass.ends_on` are the
  // competition's own columns, joined onto the pass row; read them from the
  // competition when there is no pass.
  const lockReason = passLockReason(page.competition.status, page.competition.ends_on);
```

Verify that `page.competition` carries `status` and `ends_on`. If it does not, extend the query that builds it — do **not** add a second round trip, and do **not** fall back to `pass ? … : null`.

- [ ] **Step 4: Stop advertising pass columns on a closed competition**

At `:270-275`, replace the `columns` expression with:

```ts
  const closedToPasses = state.kind === "closed";
  const columns: string[] = paidPlan
    ? ["community", planKey, ...exceedingRungs]
    : pass
      ? ["community", heldRung, "pro"]
      // A closed competition can buy neither rung, so neither rung gets a
      // column. The comparison table is the page's second offer surface and it
      // has to obey the same line the ticket does.
      : closedToPasses
        ? ["community", "pro"]
        : ["community", "event_pass", "event_pass_l", "pro"];
```

Move the `const state = upgradePageState({…})` call above this block if it is currently below it.

- [ ] **Step 5: Exclude `closed` from the Ticket by type**

At `:480-506`, change the `state` prop type:

```ts
  /**
   * `paid_plan` and `closed` are both handled by their own panels above. The
   * exclusion is load-bearing, not tidiness: this component's stub renders
   * `<PassUpgradeButton canBuy={state.canBuy}>` in its else-branch, and
   * `closed` also carries a `canBuy`, so a `closed` state reaching here would
   * typecheck perfectly and render a Buy button on the exact page this change
   * exists to stop selling from.
   */
  state: Exclude<UpgradePageState, { kind: "paid_plan" } | { kind: "closed" }>;
```

- [ ] **Step 6: Add the ClosedPanel and render it**

Add this component next to `PlanPanel`:

```tsx
/**
 * Past the line, nothing ever bought (#376). Deliberately NOT the ticket: the
 * ticket renders a rung name, a purchase date and a receipt stub, and all
 * three would be invented here. A plain card says the true thing and offers
 * the one next step that exists.
 */
function ClosedPanel({
  dict,
  state,
  nextEditionHref,
  settingsHref,
}: {
  dict: Dict;
  state: Extract<UpgradePageState, { kind: "closed" }>;
  nextEditionHref: string;
  settingsHref: string;
}) {
  // Through the Record, never `state.reason === "terminal" ? … : …` — a third
  // lock reason must break the build rather than quietly get filed under "ran
  // past its end date", which is the wrong sentence AND the wrong next step.
  const links: Record<PassLockReason, { href: string; label: DictionaryKey }> = {
    terminal: { href: nextEditionHref, label: "pass.entry.ended.nextEdition" },
    past_ends_on: { href: settingsHref, label: "pass.entry.closed.updateEndDate" },
  };
  const link = links[state.reason];
  return (
    <section className="card mt-6 p-6" data-pass-closed-panel data-pass-closed-reason={state.reason}>
      <h2 className="app-display text-lg font-bold text-slate-900">
        {t(dict, "upgrade.closed.title")}
      </h2>
      <p className="mt-2 text-sm text-slate-600">{t(dict, PASS_CLOSED_REASON_KEY[state.reason])}</p>
      {state.canBuy && (
        <Link
          href={link.href}
          data-pass-closed-link
          className="-my-1 mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-purple-700 underline decoration-purple-300 underline-offset-2 hover:text-purple-800 hover:decoration-purple-500"
        >
          {t(dict, link.label)} →
        </Link>
      )}
    </section>
  );
}
```

At the render site (`:384`), make it a three-way:

```tsx
      {state.kind === "paid_plan" ? (
        <PlanPanel
          dict={dict}
          planKey={planKey}
          orgSlug={orgSlug}
          orgName={page.org.name}
          holdsPass={!!pass}
          passAdds={heldExceeds}
        />
      ) : state.kind === "closed" ? (
        <ClosedPanel
          dict={dict}
          state={state}
          nextEditionHref={routes.competitionNew(orgSlug)}
          settingsHref={routes.competitionSettings(orgSlug, compSlug)}
        />
      ) : (
        <Ticket
```

Add `PASS_CLOSED_REASON_KEY` to the `@/lib/pass-ladder` import and `Link`/`routes` if not already imported.

- [ ] **Step 7: Correct the checkout route's stale comment**

`apps/web/src/app/api/billing/pass-checkout/route.ts`, replace the sentence "THE ROUTE IS THE AUTHORITY, even though the offer surfaces now suppress this." with:

```
    // THE ROUTE IS THE AUTHORITY. The offer surfaces suppress this as of #376 —
    // before it, they suppressed it only for a competition that HELD a pass,
    // and a never-held one rendered a live checkout that landed here for a 410.
    // The refusal below is not a backstop for a bug that was fixed; it is the
    // rule, and `/upgrade` is a direct link an organiser can hold in a bookmark
    // or an email long after the event.
```

- [ ] **Step 8: Extend the entry-point test**

Append to `apps/web/src/app/__tests__/pass-entry-points.test.ts`:

```ts
it("renders no checkout control on a closed competition's upgrade page", async () => {
  const html = await renderUpgradePage({ status: "completed", pass: null, plan: "community" });
  // Anchor on `="` — React serialises an omitted prop as "$undefined", so a
  // bare attribute probe passes in both states and proves nothing.
  expect(html).toContain('data-pass-closed-panel="');
  expect(html).not.toContain('data-pass-cta="');
  expect(html).not.toContain("event_pass_l");
});
```

Match the file's existing helper names; if it renders through a different entry point, follow that pattern rather than introducing `renderUpgradePage`.

- [ ] **Step 9: Verify and commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/app/__tests__/pass-entry-points.test.ts src/lib/__tests__/upgrade-page-state.test.ts --reporter=json --outputFile=/tmp/t4.json > /tmp/t4.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/t4.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
cd /Users/ashokhein/github/wt-pass-376 && pnpm run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/tc.log
cd /Users/ashokhein/github/wt-pass-376 && pnpm run openapi:gen && pnpm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-pass-376 && git add -A && git commit -m "fix(pass): the upgrade page gets its own closed panel instead of a dead checkout

The ended panel is built around a pass that exists — rung name, purchase
date, receipt stub — so a never-held competition gets its own card rather
than three invented facts. Ticket's state prop excludes closed by type: its
stub reads state.canBuy, which closed also carries, so the wrong panel would
have typechecked and rendered a Buy button.

The comparison table drops both pass columns for a closed competition; it is
the page's second offer surface and obeys the same line."
```

---

### Task 5: Part A end-to-end, smoke, and mobile proof

**Files:**
- Modify: `apps/web/e2e/event-pass.spec.ts`
- Modify: `scripts/seed-demo.ts`

- [ ] **Step 1: Extend the demo seed**

In `scripts/seed-demo.ts`, after the existing competition creation (around `:915`), add a competition that exercises this state — a completed competition with no pass:

```ts
  // #376 — a competition past the pass line that never held a pass. The state
  // has no card of its own anywhere else in the demo, and smoke is where a
  // regression in it would otherwise go unseen.
  const closedComp = await call("/api/v1/competitions", "POST", {
    name: "Winter 2024 (finished)",
    starts_on: "2024-11-01",
    ends_on: "2024-12-15",
    visibility: "public",
  });
  await call(`/api/v1/competitions/${closedComp.id}`, "PATCH", { status: "completed" });
```

- [ ] **Step 2: Write the e2e spec**

Append to `apps/web/e2e/event-pass.spec.ts`:

```ts
test("a finished competition offers no pass, and its upgrade page sells nothing", async ({ page }) => {
  await page.goto(`/o/${ORG}/c/winter-2024-finished`);
  // The chip is gone…
  await expect(page.locator("[data-pass-entry]")).toHaveCount(0);
  // …and the state that replaced it points somewhere useful.
  const closed = page.locator("[data-pass-closed-link]");
  await expect(closed).toBeVisible();

  await page.goto(`/o/${ORG}/c/winter-2024-finished/upgrade`);
  await expect(page.locator("[data-pass-closed-panel]")).toBeVisible();
  await expect(page.locator("[data-pass-cta]")).toHaveCount(0);
});

test("the closed state is usable at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/o/${ORG}/c/winter-2024-finished/upgrade`);
  await expect(page.locator("[data-pass-closed-panel]")).toBeVisible();
  // No horizontal page scroll.
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflows).toBe(false);
  // 44px touch target.
  const box = await page.locator("[data-pass-closed-link]").boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
});
```

Use whatever org constant the file already defines rather than introducing `ORG` if one exists.

- [ ] **Step 3: Run e2e against a real production build**

Follow the `seazn-local-env` skill §3 exactly. The two traps that cost the most here: `next start` returns 200 while serving the wrong server under `output: standalone`, and a squatted port 3100 makes all three projects fail in `auth.setup` on a magic-link timeout. Use `localhost`, never `127.0.0.1` — the session cookie is `Secure` under `NODE_ENV=production` and every API call 401s on the IP form while the browser stays signed in.

Assert the server on 3100 is yours before believing any result:

```bash
cd /Users/ashokhein/github/wt-pass-376 && lsof -t -i:3100
```

- [ ] **Step 4: Commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && git add apps/web/e2e/event-pass.spec.ts scripts/seed-demo.ts && git commit -m "test(pass): e2e and demo cover a finished competition with no pass

Both halves of #376 in one flow — no chip in the header, no checkout on the
upgrade page — plus the 375px proof the standing rule requires."
```

---

### Task 6: One definition of "this division has recorded results"

**Files:**
- Create: `db/migration/deltas/V354__division_slot_consumption.sql`
- Modify: `apps/web/src/server/usecases/divisions.ts:110-116` (quota), `:276-300` (delete guard), `:359-370` (restore quota)
- Test: `apps/web/src/server/usecases/__tests__/division-slot-consumption.test.ts` (new)

**Interfaces:**
- Produces: SQL `division_has_results(uuid) → boolean`; columns `divisions.slot_waived_at timestamptz`, `divisions.slot_waived_by uuid`. Tasks 7 and 8 depend on both.

- [ ] **Step 1: Write the migration**

```sql
-- V354 — a division's quota slot is spent by RECORDED RESULTS, not by existence.
--
-- `divisions.per_competition.max` counted only `archived_at is null`, on the
-- rule "archiving frees the slot (v3/09 §4)". Community's bite is 1 active
-- competition with 2 divisions (V270), so create → play → archive → create
-- again was unlimited divisions inside one competition, for nothing.
--
-- The guard already existed on the OTHER door: deleteDivision refuses a played
-- division with DIVISION_HAS_RESULTS. Archive was a delete that skipped that
-- guard and refunded the slot as well.
--
-- Deliberately NARROWER than delete's predicate. Delete asks
-- `status <> 'setup' OR decided > 0` because it destroys data. Nothing is
-- destroyed here, and merely PUBLISHING a division before noticing the sport
-- or variant is wrong is a mistake, not usage — burning a paid slot for it is
-- the unfairness this rule exists to avoid. Only a real result spends the slot.
--
-- STABLE, not IMMUTABLE (cf. pass_applies, V343, which takes scalars and reads
-- no table). SECURITY INVOKER by default, deliberately: RLS on `fixtures` then
-- applies to the caller, and both call sites already run inside withTenant.
create or replace function division_has_results(p_division_id uuid)
  returns boolean
  language sql stable as $$
    select exists (
      select 1 from fixtures f
       where f.division_id = p_division_id
         and f.status in ('decided', 'finalized', 'forfeited'))
  $$;

-- The quota count evaluates this per archived division on every division
-- create. Partial, because only these three statuses are ever asked about.
create index if not exists fixtures_division_results_idx
  on fixtures (division_id)
  where status in ('decided', 'finalized', 'forfeited');

-- The escape hatch (staff-only). An org can burn a slot by genuine accident —
-- one stray recorded result — and a rule with a support path beats a rule with
-- a timer that doubles as a loophole.
alter table divisions add column if not exists slot_waived_at timestamptz;
alter table divisions add column if not exists slot_waived_by uuid;
```

- [ ] **Step 2: Apply it and prove the function**

```bash
cd /Users/ashokhein/github/wt-pass-376 && DATABASE_URL="postgresql://postgres@127.0.0.1:54329/seazn_test" DATABASE_SSL=disable pnpm run db:apply > /tmp/fw.log 2>&1; echo "EXIT=$?"; tail -3 /tmp/fw.log
```

If the test database does not exist yet, build it with `seazn-local-env` §1 — and remember `db:apply` alone is not a fresh schema: without `sync:sports`, `funnel.test.ts` fails `expected 'generic' to be 'badminton'`, which reads exactly like a regression on this branch.

- [ ] **Step 3: Write the failing tests**

Create `apps/web/src/server/usecases/__tests__/division-slot-consumption.test.ts`:

```ts
describe("a division's quota slot (#376 branch, part C)", () => {
  // The evasion, exactly: community gets 2 divisions per competition (V270).
  it("does not refund the slot when a division with results is archived", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const a = await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await recordDecidedFixture(b.id);
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    await expect(createDivision(auth, competitionId, divisionInput("C"))).rejects.toMatchObject({
      status: 402,
      featureKey: "divisions.per_competition.max",
    });
    expect(a.id).toBeTruthy();
  });

  // The mistake case the rule must keep free.
  it("still refunds the slot when an UNPLAYED division is archived", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    const c = await createDivision(auth, competitionId, divisionInput("C"));
    expect(c.id).toBeTruthy();
  });

  // Narrower than delete's predicate, on purpose: publishing is not usage.
  it("does not spend the slot for a published division with no results", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await setDivisionStatus(b.id, "scheduled");
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    const c = await createDivision(auth, competitionId, divisionInput("C"));
    expect(c.id).toBeTruthy();
  });

  it("counts only decided, finalized and forfeited fixtures as results", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("A"));
    await recordFixtureWithStatus(d.id, "scheduled");
    expect(await divisionHasResults(d.id)).toBe(false);
    await recordFixtureWithStatus(d.id, "forfeited");
    expect(await divisionHasResults(d.id)).toBe(true);
  });

  it("frees the slot again once staff waive it", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await recordDecidedFixture(b.id);
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);
    await waiveDivisionSlot(b.id, STAFF_USER_ID);

    const c = await createDivision(auth, competitionId, divisionInput("C"));
    expect(c.id).toBeTruthy();
  });
});
```

Build the helpers (`seedCommunityCompetition`, `divisionInput`, `recordDecidedFixture`, `recordFixtureWithStatus`, `setDivisionStatus`, `closeRegistration`, `divisionHasResults`, `waiveDivisionSlot`) from the patterns already in `apps/web/src/server/usecases/__tests__/division-delete.test.ts`, which seeds divisions and fixtures for the delete guard. Do not duplicate a helper that file already exports.

- [ ] **Step 4: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/server/usecases/__tests__/division-slot-consumption.test.ts --reporter=json --outputFile=/tmp/dsc.json > /tmp/dsc.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/dsc.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: the first and last cases fail (a third division is created where it should 402).

- [ ] **Step 5: Count consumed slots**

`apps/web/src/server/usecases/divisions.ts`, in `createDivision`, replace the count query and its comment:

```ts
    // Doc 10 §1: `divisions.per_competition.max` (Community's real bite: 2 —
    // V270). Counted in the same tx as the insert (doc 10 §2 rule 1).
    //
    // An archived division still counts once it has RECORDED RESULTS. Archiving
    // used to free the slot unconditionally, which made create → play → archive
    // → create an unlimited-divisions loop inside one competition: archive was
    // a delete that skipped delete's own DIVISION_HAS_RESULTS guard and got the
    // slot back as well. An UNPLAYED division archived still frees its slot, so
    // fixing a division configured with the wrong sport stays free.
    const [{ n }] = await tx<{ n: number }[]>`
      select count(*)::int as n from divisions d
      where d.competition_id = ${competitionId}
        and (d.archived_at is null
             or (division_has_results(d.id) and d.slot_waived_at is null))`;
```

Apply the identical predicate to `restoreDivision`'s count (`:359-368`), replacing `where competition_id = ${existing.competition_id} and archived_at is null`.

- [ ] **Step 6: Make the delete guard call the same function**

In `deleteDivision`, replace the inline `decided` count:

```ts
    // ONE definition of "has recorded results", shared with the quota count
    // above (V354). The two ask different questions of it — delete refuses,
    // the quota charges — but they must never disagree about the answer, and
    // this repo's recurring defect is exactly a forked copy of one rule.
    const [{ has_results }] = await tx<{ has_results: boolean }[]>`
      select division_has_results(${id}) as has_results`;
```

and change the guard's condition from `division.status !== "setup" || decided > 0` to `division.status !== "setup" || has_results`. Delete's predicate stays broad on purpose — the comment above it should say so:

```ts
    // Broader than the SLOT rule (V354) deliberately: this destroys data, so a
    // division that merely LEFT setup is protected too. The slot rule charges
    // only for real results, because publishing a misconfigured division and
    // archiving it is a mistake, not usage.
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/server/usecases/__tests__/division-slot-consumption.test.ts src/server/usecases/__tests__/division-delete.test.ts --reporter=json --outputFile=/tmp/dsc.json > /tmp/dsc.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/dsc.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
```

Expected: `fail 0`. `division-delete.test.ts` must stay green — if it reds, the delete predicate was narrowed by mistake.

- [ ] **Step 8: Commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && git add db/migration/deltas/V354__division_slot_consumption.sql apps/web/src/server/usecases/divisions.ts apps/web/src/server/usecases/__tests__/division-slot-consumption.test.ts && git commit -m "fix(entitlements): a division with recorded results keeps its quota slot

Archiving refunded the slot unconditionally, so create-play-archive-create
was unlimited divisions inside one competition on a 2-division plan. Archive
was a delete that skipped delete's own DIVISION_HAS_RESULTS guard and got the
slot back too.

The slot rule is narrower than delete's on purpose: only a recorded result
spends it, so archiving a division published with the wrong sport is still
free. Both now read one SQL function rather than two copies of the rule."
```

---

### Task 7: The staff waiver

**Files:**
- Create: `apps/web/src/server/usecases/admin-divisions.ts`
- Create: `apps/web/src/app/api/admin/divisions/[id]/slot-waiver/route.ts`
- Modify: the `/admin` division view (locate with `git grep -n "admin" -- apps/web/src/app/admin | head`)
- Test: `apps/web/src/server/usecases/__tests__/admin-division-slot-waiver.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
describe("staff slot waiver", () => {
  it("frees a consumed slot and records who did it", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await createDivision(auth, competitionId, divisionInput("A"));
    const b = await createDivision(auth, competitionId, divisionInput("B"));
    await recordDecidedFixture(b.id);
    await closeRegistration(b.id);
    await archiveDivision(auth, b.id);

    await waiveDivisionSlot(STAFF_AUTH, b.id);
    const [row] = await sql`select slot_waived_at, slot_waived_by from divisions where id = ${b.id}`;
    expect(row.slot_waived_at).not.toBeNull();
    expect(row.slot_waived_by).toBe(STAFF_AUTH.userId);

    const c = await createDivision(auth, competitionId, divisionInput("C"));
    expect(c.id).toBeTruthy();
  });

  it("refuses a non-staff caller", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("A"));
    await expect(waiveDivisionSlot(auth, d.id)).rejects.toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/server/usecases/__tests__/admin-division-slot-waiver.test.ts --reporter=json --outputFile=/tmp/wv.json > /tmp/wv.log 2>&1; echo "EXIT=$?"
```

Expected: fails with "waiveDivisionSlot is not a function".

- [ ] **Step 3: Implement the use case**

`apps/web/src/server/usecases/admin-divisions.ts`:

```ts
/**
 * Staff-only: clear a division's slot consumption (V354).
 *
 * An org can spend a division slot by genuine accident — one stray recorded
 * result on a division it then archives. The slot rule has no timer by design
 * (any window long enough to close the archive-and-recreate loop is short
 * enough to punish an honest mistake), so this is the escape hatch instead.
 *
 * Audited, because it moves an entitlement boundary for a paying customer.
 */
export async function waiveDivisionSlot(auth: AuthCtx, divisionId: string): Promise<void> {
  assertStaff(auth);
  await sql`
    update divisions
       set slot_waived_at = now(), slot_waived_by = ${auth.userId}
     where id = ${divisionId}`;
  await auditAdmin(auth.userId, "division_slot_waived", { division_id: divisionId });
}
```

Use whatever staff assertion and admin-audit helper `/admin`'s existing use cases already use — find them with `git grep -n "assertStaff\|auditAdmin" -- apps/web/src/server`. Do not introduce a second staff check.

- [ ] **Step 4: Add the route and the `/admin` control**

The route posts to `waiveDivisionSlot` and returns 204. The `/admin` control is a single button next to the division row, labelled in English only (`/admin` is staff-only and owes no i18n), with a confirm step. Functional bar per the standing rule — no design polish — but it must be usable at 375px.

- [ ] **Step 5: Verify and commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/server/usecases/__tests__/admin-division-slot-waiver.test.ts --reporter=json --outputFile=/tmp/wv.json > /tmp/wv.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/wv.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
cd /Users/ashokhein/github/wt-pass-376 && pnpm run openapi:gen && git status --porcelain
cd /Users/ashokhein/github/wt-pass-376 && git add -A && git commit -m "feat(admin): staff can waive a division's consumed quota slot

The slot rule has no timer by design — any window long enough to close the
archive-and-recreate loop is short enough to punish an honest mistake — so a
stray recorded result gets a support path instead of a loophole. Audited."
```

---

### Task 8: Say it before the click, and explain the refusal

**Files:**
- Modify: `apps/web/src/components/v2/division-danger-zone.tsx:53-90`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Modify: the 402 surface for `divisions.per_competition.max`
- Modify: `apps/web/e2e/` (division spec), `scripts/seed-demo.ts`

- [ ] **Step 1: Add two keys to all four locales**

`en`:
```json
  "division.archive.slotWarning": "This division has recorded results, so archiving it will not free a division slot.",
  "division.limit.archivedCount": "Divisions with recorded results count toward your limit even after they are archived.",
```
`es`:
```json
  "division.archive.slotWarning": "Esta división tiene resultados registrados, así que archivarla no liberará una plaza de división.",
  "division.limit.archivedCount": "Las divisiones con resultados registrados cuentan para tu límite incluso después de archivarlas.",
```
`fr`:
```json
  "division.archive.slotWarning": "Cette division a des résultats enregistrés : l'archiver ne libérera pas d'emplacement de division.",
  "division.limit.archivedCount": "Les divisions avec des résultats enregistrés comptent dans votre limite même une fois archivées.",
```
`nl`:
```json
  "division.archive.slotWarning": "Deze divisie heeft geregistreerde resultaten, dus archiveren maakt geen divisieplek vrij.",
  "division.limit.archivedCount": "Divisies met geregistreerde resultaten tellen mee voor je limiet, ook nadat ze zijn gearchiveerd.",
```

- [ ] **Step 2: Warn before the archive**

`division-danger-zone.tsx` renders the warning when the division has results, above the archive button, with `data-slot-warning`. The component needs to know — pass `hasResults` from the server component that renders it rather than fetching from the client.

- [ ] **Step 3: Explain the 402**

Wherever `divisions.per_competition.max` renders its paywall copy, append `division.limit.archivedCount` when the competition has at least one archived division that consumes a slot. An org looking at one visible division and a "limit reached" message is owed the invisible cause.

- [ ] **Step 4: e2e, smoke, and mobile**

Extend the demo seed with a competition holding an archived-and-played division, and add an e2e that archives a played division and then fails to create another, asserting the explaining copy is on screen. Verify at 375px with no horizontal scroll.

- [ ] **Step 5: Verify and commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm run i18n:gen-keys && pnpm run i18n:check && git status --porcelain
cd /Users/ashokhein/github/wt-pass-376 && git add -A && git commit -m "feat(divisions): say the slot will not come back before the archive, not after

An org that archives a played division and then cannot create another can see
exactly one division on screen and a paywall with no visible cause. Both ends
now say why."
```

---

### Task 9: A terminal competition accepts no new divisions

**Files:**
- Modify: `apps/web/src/server/usecases/divisions.ts` (createDivision `:104-107`, restoreDivision)
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Test: `apps/web/src/server/usecases/__tests__/division-competition-ended.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

```ts
describe("a terminal competition accepts no new divisions", () => {
  it("refuses a create on a completed competition", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setCompetitionStatus(competitionId, "completed");
    await expect(createDivision(auth, competitionId, divisionInput("A"))).rejects.toMatchObject({
      status: 409,
      code: "COMPETITION_ENDED",
    });
  });

  it("refuses a create on an archived competition", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setCompetitionStatus(competitionId, "archived");
    await expect(createDivision(auth, competitionId, divisionInput("A"))).rejects.toMatchObject({
      status: 409,
    });
  });

  // The arm that must NOT block. past_ends_on is routinely a stale end date on
  // a competition still being played — which is exactly why part A points that
  // organiser at the settings form rather than at next season. Blocking here
  // would break a live competition over a typo.
  it("ALLOWS a create on a competition merely past its end date", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    await setCompetitionEndsOn(competitionId, "2020-01-01"); // long past grace
    const d = await createDivision(auth, competitionId, divisionInput("A"));
    expect(d.id).toBeTruthy();
  });

  it("refuses a restore into a completed competition", async () => {
    const { auth, competitionId } = await seedCommunityCompetition();
    const d = await createDivision(auth, competitionId, divisionInput("A"));
    await closeRegistration(d.id);
    await archiveDivision(auth, d.id);
    await setCompetitionStatus(competitionId, "completed");
    await expect(restoreDivision(auth, d.id)).rejects.toMatchObject({ status: 409 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/server/usecases/__tests__/division-competition-ended.test.ts --reporter=json --outputFile=/tmp/dce.json > /tmp/dce.log 2>&1; echo "EXIT=$?"
```

Expected: 3 failures; the `past_ends_on` case passes already.

- [ ] **Step 3: Implement the guard**

Add to `divisions.ts`:

```ts
/**
 * A finished competition does not grow (#376 branch, part D).
 *
 * `assertCompetitionNotFrozen` checks the over-quota freeze and says nothing
 * about status, so a completed or archived competition accepted new divisions.
 * Not a quota leak — the per-competition cap still binds — but it made
 * "completed" mean nothing, and it contradicted the same competition being
 * refused an Event Pass.
 *
 * TERMINAL ONLY. `past_ends_on` must keep accepting writes: that arm is
 * routinely a stale end date on a competition still being played, which is why
 * the pass chip points that organiser at the settings form. The pass line and
 * the write line share a vocabulary, not a threshold.
 */
async function assertCompetitionNotEnded(tx: postgres.TransactionSql, competitionId: string) {
  const [comp] = await tx<{ status: string; ends_on: Date | string | null }[]>`
    select status, ends_on from competitions where id = ${competitionId}`;
  if (comp && passLockReason(comp.status, comp.ends_on) === "terminal") {
    throw new HttpError(
      409,
      "This competition is finished, so no new divisions can be added to it",
      "COMPETITION_ENDED",
    );
  }
}
```

Call it in `createDivision` immediately after `assertCompetitionNotFrozen`, and in `restoreDivision` before its quota check. Import `passLockReason` from `@/lib/entitlements`.

- [ ] **Step 4: Add the copy to all four locales**

`en`: `"division.create.competitionEnded": "This competition is finished, so no new divisions can be added to it."`
`es`: `"division.create.competitionEnded": "Esta competición ha finalizado, por lo que no se pueden añadir nuevas divisiones."`
`fr`: `"division.create.competitionEnded": "Cette compétition est terminée : aucune nouvelle division ne peut y être ajoutée."`
`nl`: `"division.create.competitionEnded": "Deze competitie is afgelopen, dus er kunnen geen nieuwe divisies aan worden toegevoegd."`

- [ ] **Step 5: Verify, add e2e and smoke, commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/server/usecases/__tests__/division-competition-ended.test.ts --reporter=json --outputFile=/tmp/dce.json > /tmp/dce.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/dce.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests)"
cd /Users/ashokhein/github/wt-pass-376 && pnpm run openapi:gen && pnpm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-pass-376 && git add -A && git commit -m "fix(divisions): a finished competition accepts no new divisions

assertCompetitionNotFrozen checks the over-quota freeze only, never the
status, so a completed competition could still grow — while being refused an
Event Pass on the same seam.

Terminal only. past_ends_on keeps accepting writes: that arm is usually a
stale end date on a competition still being played, and blocking it would
break a live competition over a typo."
```

---

### Task 10: A mandatory, changeable end date

**Files:**
- Modify: `apps/web/src/server/api-v1/schemas.ts:44` (create), `:71` (patch), plus the cross-field refine
- Modify: `apps/web/src/components/v2/competition-wizard.tsx:129-135`
- Modify: `apps/web/src/components/v2/competition-settings.tsx:276-283`
- Modify: `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`
- Modify: every fixture/seed/e2e path creating a competition
- Test: `apps/web/src/server/api-v1/__tests__/competition-schemas.test.ts` (new — no schema-validation test file exists today)

- [ ] **Step 1: Write the failing schema tests**

```ts
describe("CreateCompetition.ends_on", () => {
  it("refuses a competition with no end date", () => {
    const r = CreateCompetition.safeParse({ name: "Spring 2026" });
    expect(r.success).toBe(false);
  });

  it("accepts one with an end date", () => {
    const r = CreateCompetition.safeParse({ name: "Spring 2026", ends_on: "2026-06-30" });
    expect(r.success).toBe(true);
  });

  it("refuses an end date before the start date", () => {
    const r = CreateCompetition.safeParse({
      name: "Spring 2026",
      starts_on: "2026-06-30",
      ends_on: "2026-01-01",
    });
    expect(r.success).toBe(false);
  });
});

describe("PatchCompetition.ends_on", () => {
  // The half that matters. A mandatory create with a nullable patch is
  // theatre: an org could PATCH ends_on:null and the competition would never
  // cross the pass line again — the same evasion shape as the division slot,
  // a write that buys its way out of a limit.
  it("refuses setting the end date back to null", () => {
    expect(PatchCompetition.safeParse({ ends_on: null }).success).toBe(false);
  });

  it("accepts a NEW end date — the date stays changeable", () => {
    expect(PatchCompetition.safeParse({ ends_on: "2026-07-31" }).success).toBe(true);
  });

  it("still accepts a patch that does not mention the end date", () => {
    expect(PatchCompetition.safeParse({ name: "Renamed" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run src/server/api-v1/__tests__/competition-schemas.test.ts --reporter=json --outputFile=/tmp/sch.json > /tmp/sch.log 2>&1; echo "EXIT=$?"
```

Expected: 3 failures (no-end-date accepted, before-start accepted, null patch accepted).

- [ ] **Step 3: Tighten the schemas**

`schemas.ts:44`:

```ts
  /**
   * REQUIRED. A competition with no end date can never reach `past_ends_on`
   * (`entitlements.ts` — `if (endsOn == null) return null`), so an optional
   * field was the single reason the date arm of the pass line rarely fired,
   * and a live competition with no end date held a `competitions.max_active`
   * slot indefinitely. Changeable, never removable — see PatchCompetition.
   */
  ends_on: z.iso.date(),
```

`schemas.ts:71` — `ends_on: z.iso.date(),` (the surrounding `.partial()` keeps it optional to *send*), and extend the existing `.refine` chain:

```ts
  .refine(
    (p) => !p.starts_on || !p.ends_on || p.ends_on >= p.starts_on,
    "ends_on cannot be before starts_on",
  )
```

Add the same refine to `CreateCompetition`. ISO `YYYY-MM-DD` strings compare correctly lexicographically, so no Date construction is needed.

- [ ] **Step 4: Make the forms require it**

`competition-wizard.tsx` marks the end-date input `required`, blocks submit without it, and shows `comp.wizard.endsOn.required`. `competition-settings.tsx` keeps the field editable and shows `comp.validation.endsBeforeStarts` when the order is wrong. Both at 375px with 44px targets.

Copy for all four locales:

`en`:
```json
  "comp.wizard.endsOn.required": "An end date is required.",
  "comp.validation.endsBeforeStarts": "The end date cannot be before the start date.",
```
`es`:
```json
  "comp.wizard.endsOn.required": "La fecha de finalización es obligatoria.",
  "comp.validation.endsBeforeStarts": "La fecha de finalización no puede ser anterior a la de inicio.",
```
`fr`:
```json
  "comp.wizard.endsOn.required": "Une date de fin est requise.",
  "comp.validation.endsBeforeStarts": "La date de fin ne peut pas précéder la date de début.",
```
`nl`:
```json
  "comp.wizard.endsOn.required": "Een einddatum is verplicht.",
  "comp.validation.endsBeforeStarts": "De einddatum kan niet vóór de startdatum liggen.",
```

- [ ] **Step 5: Fix the fixture fallout**

Find every competition-creation site and give each an end date:

```bash
cd /Users/ashokhein/github/wt-pass-376 && git grep -ln "api/v1/competitions\|insert into competitions\|createCompetition" -- apps/web/src apps/web/e2e scripts
```

Owner decision: fix them all here rather than defaulting `ends_on` in a test factory. A factory that silently supplies the field would hide the new requirement from every test that ought to be asserting it.

- [ ] **Step 6: Full suite, both drift gates, commit**

```bash
cd /Users/ashokhein/github/wt-pass-376 && git status --porcelain && pnpm -F @seazn/web exec vitest run --reporter=json --outputFile=/tmp/all.json > /tmp/all.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/all.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'suitesFailed',r.numFailedTestSuites)"
cd /Users/ashokhein/github/wt-pass-376 && pnpm run openapi:gen && pnpm run i18n:gen-keys && git status --porcelain
cd /Users/ashokhein/github/wt-pass-376 && git add -A && git commit -m "feat(competitions): an end date is required, and can be changed but not removed

A competition with no end date can never reach past_ends_on, so the optional
field was the only reason the date arm of the pass line rarely fired.

PATCH refuses null rather than merely requiring the field on create: a
mandatory create with a nullable patch is theatre — an org could clear the
date and the competition would never cross the line again, the same evasion
shape as the division slot."
```

---

### Task 11: Branch gates

- [ ] **Step 1: Confirm the tree is yours and clean**

```bash
cd /Users/ashokhein/github/wt-pass-376 && git status --porcelain; readlink -f node_modules/@seazn/engine
```

`node_modules/@seazn/engine` must resolve **inside** the worktree — a symlink to the main checkout silently compiles main's engine.

- [ ] **Step 2: Full unit suite, judged from JSON**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm -F @seazn/web exec vitest run --reporter=json --outputFile=/tmp/final.json > /tmp/final.log 2>&1; echo "EXIT=$?"
cd /Users/ashokhein/github/wt-pass-376 && node -e "const r=require('/tmp/final.json');console.log('pass',r.numPassedTests,'fail',r.numFailedTests,'total',r.numTotalTests,'suitesFailed',r.numFailedTestSuites);console.log(r.testResults.filter(t=>!t.name.startsWith('/Users/ashokhein/github/wt-pass-376')).map(t=>t.name).join('\n')||'all paths in worktree')"
```

If `total` is far below expectation with a large `pending` count, the `.env.local` symlinks are broken and ~1772 DB tests skipped themselves — that is not a green run.

- [ ] **Step 3: Lint and typecheck, read honestly**

```bash
cd /Users/ashokhein/github/wt-pass-376 && rm -rf apps/web/.next
cd /Users/ashokhein/github/wt-pass-376 && pnpm run typecheck > /tmp/tc.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/tc.log
cd /Users/ashokhein/github/wt-pass-376 && npx eslint apps/web/src > /tmp/lint.log 2>&1; echo "EXIT=$?"; grep -c "problem" /tmp/lint.log
```

`rtk` hides lint output entirely and prints `PASS(0) FAIL(0)` for a suite that failed to collect — read `✖ N problems` from raw eslint, not from a wrapper summary. `apps/web` typecheck peaks around 2.8 GB.

- [ ] **Step 4: Both drift gates**

```bash
cd /Users/ashokhein/github/wt-pass-376 && pnpm run openapi:gen && pnpm run i18n:gen-keys && pnpm run i18n:check && git status --porcelain
```

`git status --porcelain` must print nothing. Anything it prints is drift that CI will red.

- [ ] **Step 5: e2e against a real standalone build**

Follow `seazn-local-env` §3. Build, copy `.next/static` and `public` into `.next/standalone`, serve with `node server.js`, and target `localhost` (never `127.0.0.1` — the `Secure` cookie 401s every API call on the IP form).

- [ ] **Step 6: Screenshots at desktop and 375px**

Every surface this branch touched: the competition header chip, the upgrade page's closed panel, the division danger zone warning, the competition wizard's end-date field, and the `/admin` waiver control. No horizontal page scroll at 375px.

- [ ] **Step 7: Help pages**

```bash
cd /Users/ashokhein/github/wt-pass-376 && git grep -ln "Event Pass\|division" -- content/help | head
```

Update the pages describing when a pass can be bought and how division limits count. One English tree — no i18n owed.

- [ ] **Step 8: Push and open the PR**

Smoke CI runs on **PRs only**; merging locally and pushing to `main` skips it. This branch changes behaviour in four places and must go through a PR.

---

## Self-review

**Spec coverage.** Part A → Tasks 1–5 (state, provider/layout, chip, page, e2e+smoke). Part C → Tasks 6–8 (function+quota+delete, waiver, honesty surfaces). Part D → Task 9. Part B → Task 10. Gates → Task 11. The spec's "competition slots — answered, unchanged" section is documentation, not work, and correctly has no task.

**Known soft spots, called out rather than hidden.**
- Tasks 7, 8 and 10 steps 4–5 describe UI work without full JSX. That is deliberate: the `/admin` division view, the 402 paywall surface and the two competition forms were not read line-by-line during planning, and inventing their markup would produce code the implementer must discard. Each of those steps names the file, the data it needs, the `data-` hook to add, and the acceptance criteria. The implementer reads the file first.
- Task 2 Step 6 and Task 3 Step 2 assume helper names (`passStateForTest`, `wrapperWith`, `renderEntry`) in existing test files. Each step says to use the file's own helper if the name differs — do not add a parallel one.
- Task 4 Step 3 assumes `page.competition` carries `status` and `ends_on`. If it does not, extend the existing query; do not add a round trip and do not restore the `pass ? … : null` shape.

**Type consistency.** `closed` carries `{reason, canBuy}` in Task 1, is consumed with that shape in Task 4, and the chip's parallel state reads `lockReason` from context (not from a state payload) in Task 3 — the two surfaces get the reason by different routes on purpose, because the island cannot call `passLockReason`. `division_has_results` is named identically in the migration, the quota count, the delete guard, and the tests.
