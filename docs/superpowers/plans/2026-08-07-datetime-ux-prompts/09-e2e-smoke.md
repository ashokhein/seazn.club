# Prompt 09: E2E + smoke coverage for the whole feature set

**Context**: `docs/superpowers/RULES.md` — every task ultimately owes
E2E + smoke coverage; this is where it lands for this whole programme,
once the full chain is visible end-to-end (mirrors the CP-SAT
programme's own Prompt 11 for the same reason). **Needs Prompts 02-08
all done** — this is the only prompt in this index that depends on
nearly everything else.

**Acceptance criteria**: a real browser, driven by Playwright against a
real running app, confirms (a) a blackout window actually blocks that
time on the board, (b) removing a court with a pinned fixture is
rejected with a clear message, (c) the board renders with no horizontal
scroll at 375px under the new segmentation. Plus one smoke-tier check
for fast CI-adjacent confidence.

**Do not touch**: application code — if a test here fails, that's a
signal a PRIOR prompt (02-08) has a real gap; fix it there, don't
adjust this test to match broken behavior.

**Files:**
- Create: `e2e/schedule-datetime-ux.spec.ts`
- Modify: `scripts/smoke.ts`

**Interfaces:**
- Consumes: the real running app, all of Prompts 01-08's changes.

- [ ] **Step 1: Find the real routes and helpers first**

Read this repo's existing e2e specs under `e2e/` for the real route
paths to the constraints panel and schedule board, the auth setup
pattern, and any existing fixture-seeding helper for a pinned/locked
fixture. Do not guess these — an e2e spec built on invented routes
will fail for the wrong reason and waste the whole verification step.

- [ ] **Step 2: Write the E2E spec using the real routes/helpers found in Step 1**

```typescript
// e2e/schedule-datetime-ux.spec.ts
import { test, expect } from "@playwright/test";

test.describe("date/time scheduling UX", () => {
  test("organiser adds a blackout window and it blocks that time on the board", async ({ page }) => {
    await page.goto("/* real constraints-panel route from Step 1 */");
    await page.getByRole("button", { name: /add blackout/i }).click();
    await page.getByLabel(/blackout start/i).fill("12:00");
    await page.getByLabel(/blackout end/i).fill("13:00");
    await page.getByRole("button", { name: /save/i }).click();
    await page.goto("/* real board route from Step 1 */");
    await page.getByRole("button", { name: /auto.?schedule/i }).click();
    await expect(page.locator('[data-testid="board-cell"][data-hour="12"]')).toBeEmpty();
  });

  test("removing a court with a pinned fixture is rejected with a clear message", async ({ page }) => {
    // seed via the real helper found in Step 1
    await page.goto("/* real board settings route */");
    await page.getByRole("button", { name: /remove court 2/i }).click();
    await page.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText(/court 2/i)).toBeVisible();
    await expect(page.getByText(/pinned/i)).toBeVisible();
  });

  test("board renders without horizontal scroll at 375px with the new segmentation", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/* real board route */");
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBe(clientWidth);
  });
});
```

- [ ] **Step 3: Add smoke coverage**

Read `scripts/smoke.ts`'s existing structure (a control-run pattern
already exists for similarly hard-to-E2E cases — find and follow it).
Add a smoke check: a division with a configured blackout window and a
fresh auto-schedule run produces a board with zero assignments inside
the blackout — lighter-weight and faster than the full E2E spec.

- [ ] **Step 4: Run the E2E spec locally**

Bring up the app per this repo's local e2e recipe (prod build +
`E2E_PROD_TARGET`, not `npm run dev` — per `seazn-local-env` skill).
Run the spec. Expected: all 3 cases pass.

- [ ] **Step 5: Run smoke**

Run this repo's actual smoke invocation (confirm from `package.json`'s
scripts rather than guessing the command).
Expected: the new blackout check passes alongside existing checks.

- [ ] **Step 6: Commit**

```bash
git add e2e/schedule-datetime-ux.spec.ts scripts/smoke.ts
git commit -m "test(e2e): cover blackout windows, court-removal guard, and 375px board layout end-to-end"
```

**Verify**: E2E spec 3/3 passing against a real local server, smoke check passing. Per `docs/superpowers/RULES.md`, a failure in an unrelated EXISTING e2e spec is noted and skipped, not chased — but any of these 3 new cases failing is this prompt's own responsibility.

**Output cap**: final message under 15 lines — E2E pass count, smoke result, the real routes/helpers you found and used in place of the placeholders above.
