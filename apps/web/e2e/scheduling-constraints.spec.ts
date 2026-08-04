import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi } from "./helpers";

/**
 * The scheduling rules an organiser STORES, proven on the board (#452).
 *
 * Why this file exists at all. Four defects — #443, #446, #447 and the #457
 * repair rounding — shipped past a fully green suite, and every one of them had
 * the same shape: a rule that compiles, displays as enforced, and binds
 * nothing. None was reachable from e2e, for two structural reasons:
 *
 *   1. **No UI writes `constraints.hard`.** Verified again while writing this
 *      file: `grep -a -rn "constraints.hard"` over `src/components` and
 *      `src/app` returns nothing. `constraints-panel.tsx` writes
 *      `crossPersonClash: "hard" | "warn"`, a different field entirely. So the
 *      rule has to be seeded through `PUT /api/v1/divisions/{id}/schedule-settings`
 *      and then ASSERTED on what the board renders. That split is deliberate:
 *      an API-only assertion would re-test the same usecase the unit suite
 *      already covers, and the surface the organiser is actually promised is
 *      the board's conflicts badge.
 *   2. **No spec created a pool-bearing stage.** `kind: "group"` with
 *      `config.pools.count > 1` is the only kind that writes `fixtures.pool_id`,
 *      and until this file nothing in `e2e/` created one — so a pool-targeted
 *      rule (#446) was unreachable.
 *
 * EVERY TEST HERE IS TWO-SIDED, and that is the whole design. A one-sided
 * "the badge appears" assertion is satisfied by a rule that binds nothing as
 * long as SOMETHING else on the board conflicts, and it is satisfied by a
 * board-wide rest floor that ignores the rule's scope entirely. So each test
 * renders the SAME board twice and changes exactly one thing — the stored rule
 * — and requires the badge to follow it in both directions.
 *
 * These conflicts are WARN-ONLY by design (`isBlockingConflict` in
 * packages/engine/src/scheduling/calendar.ts covers `court`, `person_overlap`,
 * `window` and direct `order` — not `rest`, not `instruction`). So nothing here
 * asserts a refused save, and each test additionally pins that no RED row
 * appears: a rest rule that started blocking writes would be a regression this
 * file should fail on.
 */

/** Mon 12 Oct 2026, 09:00 UTC — a fixed weekday instant so nothing here can
 *  drift with the calendar. */
const START = Date.UTC(2026, 9, 12, 9, 0);
const MATCH_MINUTES = 45;
const MIN = 60_000;

/** Enough rest that a back-to-back pair cannot possibly satisfy it, and far
 *  enough from any core setting that a stray default cannot supply it. */
const REST_MINUTES = 240;

interface FixtureRow {
  id: string;
  pool_id: string | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
}

const rand = () => Math.random().toString(36).slice(2, 6);

/** A private competition + one generic division, its entrants, and one stage's
 *  generated fixtures. Returns the FULL fixture rows, not just ids: the pool
 *  test needs `pool_id` and both tests need the entrant pair. */
async function seedDivision(
  request: APIRequestContext,
  opts: {
    entrants: string[];
    stage: { kind: string; name: string; config?: Record<string, unknown> };
  },
): Promise<{ divisionId: string; stageId: string; fixtures: FixtureRow[] }> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Constraints ${TAG}-${rand()}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Constraints",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, opts.entrants);
  const stage = await apiJson<{ id: string }>(
    request,
    `/api/v1/divisions/${divisionId}/stages`,
    "POST",
    { seq: 1, ...opts.stage },
  );
  const stageId = stage.data!.id;
  const gen = await apiJson<{ fixtures: FixtureRow[] }>(
    request,
    `/api/v1/stages/${stageId}/generate`,
    "POST",
  );
  expect(gen.status).toBeLessThan(300);
  return { divisionId, stageId, fixtures: gen.data?.fixtures ?? [] };
}

/**
 * The board's calendar inputs, with `constraints` as the ONLY variable.
 *
 * `perEntrantMinRest: 0` is load-bearing. It is the one setting that can
 * produce a `rest` conflict without any stored rule at all, so leaving it at
 * zero means a rest row on this board has exactly one possible author: the
 * `constraints` object passed in here.
 */
async function putSettings(
  request: APIRequestContext,
  divisionId: string,
  constraints: Record<string, unknown>,
): Promise<void> {
  const res = await apiJson(request, `/api/v1/divisions/${divisionId}/schedule-settings`, "PUT", {
    tz: "UTC",
    config: {
      startAt: new Date(START).toISOString(),
      matchMinutes: MATCH_MINUTES,
      gapMinutes: 0,
      courts: ["Court A", "Court B"],
      perEntrantMinRest: 0,
      blackouts: [],
      sessionWindows: [],
      constraints,
    },
  });
  // A 402 here means the org lost `scheduling.constraints` and the whole file
  // would then "pass" its negative halves for the wrong reason.
  expect(res.status, "schedule-settings PUT must be accepted").toBe(200);
}

/** Two fixtures that share an entrant, butted end-to-start on DIFFERENT courts.
 *  Different courts on purpose: same court + same time is a `court` clash,
 *  which blocks, and would mask the warn-only rest row this file is about. */
async function placeBackToBack(
  request: APIRequestContext,
  stageId: string,
  pair: [FixtureRow, FixtureRow],
): Promise<void> {
  const res = await apiJson<{ applied: number }>(
    request,
    `/api/v1/stages/${stageId}/schedule/apply`,
    "POST",
    {
      assignments: [
        {
          fixture_id: pair[0].id,
          scheduled_at: new Date(START).toISOString(),
          court_label: "Court A",
        },
        {
          fixture_id: pair[1].id,
          scheduled_at: new Date(START + MATCH_MINUTES * MIN).toISOString(),
          court_label: "Court B",
        },
      ],
      source: "manual",
    },
  );
  expect(res.status, "a warn-only board must still apply").toBe(200);
  expect(res.data!.applied).toBe(2);
}

/** Two fixtures sharing an entrant, optionally restricted to one pool. */
function sharedEntrantPair(fixtures: FixtureRow[], poolId?: string): [FixtureRow, FixtureRow] {
  const pool = poolId === undefined ? fixtures : fixtures.filter((f) => f.pool_id === poolId);
  for (const a of pool) {
    const ents = [a.home_entrant_id, a.away_entrant_id].filter((e): e is string => e !== null);
    for (const b of pool) {
      if (b.id === a.id) continue;
      if (ents.some((e) => e === b.home_entrant_id || e === b.away_entrant_id)) return [a, b];
    }
  }
  throw new Error("seed produced no two fixtures sharing an entrant");
}

/**
 * The conflicts badge and its panel.
 *
 * Located by ARIA role + accessible name, matching the convention board-v3.spec
 * already uses — `conflicts-panel.tsx` exposes no `data-*` state at all, so
 * there is nothing more stable to hold onto here (noted in the #452 report; a
 * `data-conflict-code` hook would let every assertion below drop the copy).
 * Everything the tests actually MEASURE — how many rows, and whether any is
 * blocking — is read structurally rather than from rendered English.
 */
const badge = (page: Page) => page.getByRole("button", { name: /conflicts? — open the list/ });
const panel = (page: Page) => page.getByRole("region", { name: "Schedule conflicts" });

/**
 * The board is up, and it is showing the fixtures we seeded.
 *
 * Every "no badge" assertion below is an ABSENCE, and an absence is satisfied
 * by a page that failed to render, by a 404, and by a redirect to the org
 * picker. So each one is anchored on a name this test itself chose — product
 * copy could change, `Ada` cannot.
 */
async function openBoard(page: Page, divisionId: string, anchorEntrant: string): Promise<void> {
  await page.goto(`/divisions/${divisionId}/schedule?tab=board`);
  await expect(page.getByText(anchorEntrant).first()).toBeVisible({ timeout: 20_000 });
}

test("a durable min_rest_minutes rule the API stored binds on the board — and only when stored (#447)", async ({
  page,
  request,
}) => {
  const { divisionId, stageId, fixtures } = await seedDivision(request, {
    entrants: ["Ada", "Bay", "Cy", "Dot"],
    stage: { kind: "league", name: "League" },
  });
  expect(fixtures).toHaveLength(6);
  const pair = sharedEntrantPair(fixtures);

  // ---- Direction 1: the rule is NOT stored. -------------------------------
  // Same board, same zero rest between the same two cards. If this half shows
  // a conflict then the board has some other reason to complain and direction
  // 2 proves nothing about the rule.
  await putSettings(request, divisionId, { hard: [] });
  await placeBackToBack(request, stageId, pair);
  await openBoard(page, divisionId, "Ada");
  await expect(badge(page)).toHaveCount(0);

  // ---- Direction 2: store the rule, change nothing else. ------------------
  // `min_rest_minutes` / `per_person` is deliberately folded into the rest
  // bound rather than reported as its own rule (calendar.ts,
  // `hardRestMinutesFor`), so the row this raises is `rest` — the SAME code
  // `perEntrantMinRest` produces. That is exactly why direction 1 has to pin
  // `perEntrantMinRest: 0`: it is what makes the row unambiguously the stored
  // rule's doing.
  await putSettings(request, divisionId, {
    hard: [
      {
        type: "min_rest_minutes",
        minutes: REST_MINUTES,
        rest_scope: "per_person",
        scope: { kind: "division", divisionId },
      },
    ],
  });
  await openBoard(page, divisionId, "Ada");
  await expect(badge(page)).toBeVisible({ timeout: 20_000 });

  await badge(page).click();
  const list = panel(page);
  await expect(list).toBeVisible();
  // TWO rows, not one: `validateAssignments` walks ordered pairs and reports
  // the shortfall on each side, so one too-short gap is one row per card. The
  // exact number is pinned rather than `>= 1` because it is also the assertion
  // that the rule bound the PAIR and not the whole board — six fixtures are
  // seeded and only two are placed, and a rule that had escaped its scope would
  // have more to say than this.
  await expect(list.getByRole("listitem")).toHaveCount(2);
  // Warn-only, on purpose (`isBlockingConflict` does not cover `rest`). The
  // panel paints a blocking row red and a warning amber, so a red row here
  // would mean a stored rest rule had started refusing writes.
  await expect(list.locator("li.border-red-200")).toHaveCount(0);
  await expect(list.locator("li.border-amber-200")).toHaveCount(2);

  // 375px: the panel is a bottom sheet at phone widths and nothing it adds may
  // push the page sideways. No mobile PROJECT runs this spec — playwright.config
  // scopes `mobile-se`/`mobile-14` to mobile.spec.ts — so the viewport is set
  // here or the width is never exercised at all.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(list).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a pool-targeted restByGroup binds the pool it names, and no other (#446)", async ({
  page,
  request,
}) => {
  // The first pool-bearing stage in the e2e suite. `kind: "group"` with
  // `pools.count: 2` is the only shape that writes `fixtures.pool_id`
  // (stages.ts `poolCount`), and `pool_id` is precisely what #446 was about:
  // the placer carried it, the Assignment handed to the verifier did not, so a
  // pool-keyed rule bound during placement and evaporated during verification.
  const { divisionId, stageId, fixtures } = await seedDivision(request, {
    entrants: ["Ada", "Bay", "Cy", "Dot", "Eve", "Fay"],
    stage: { kind: "group", name: "Groups", config: { pools: { count: 2 } } },
  });
  const poolIds = [...new Set(fixtures.map((f) => f.pool_id))].filter(
    (p): p is string => p !== null,
  );
  // If this is 1, the stage did not actually pool and every assertion below
  // would be about a division-keyed rule wearing a pool's name.
  expect(poolIds).toHaveLength(2);
  const [poolA, poolB] = poolIds as [string, string];
  const pair = sharedEntrantPair(fixtures, poolA);
  expect(pair[0].pool_id).toBe(poolA);
  expect(pair[1].pool_id).toBe(poolA);

  // ---- Direction 1: the rule names the OTHER pool. ------------------------
  // Not "no rule at all". A `restByGroup` that is present but keyed elsewhere
  // is the only control that distinguishes "the pool key was matched" from
  // "any restByGroup entry raises rest for everybody" — which is what a
  // dropped `poolId` would look like if the fallback happened to hit.
  await putSettings(request, divisionId, { restByGroup: { [poolB]: REST_MINUTES } });
  await placeBackToBack(request, stageId, pair);
  await openBoard(page, divisionId, "Ada");
  await expect(badge(page)).toHaveCount(0);

  // ---- Direction 2: re-key the SAME value onto this pair's pool. ----------
  await putSettings(request, divisionId, { restByGroup: { [poolA]: REST_MINUTES } });
  await openBoard(page, divisionId, "Ada");
  await expect(badge(page)).toBeVisible({ timeout: 20_000 });

  await badge(page).click();
  const list = panel(page);
  await expect(list).toBeVisible();
  // One row per card of the pair (see the note in the #447 test). Pinned, so a
  // pool rule that had leaked onto the other pool's cards would fail here even
  // if direction 1 above somehow passed.
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.locator("li.border-red-200")).toHaveCount(0);
  await expect(list.locator("li.border-amber-200")).toHaveCount(2);
});
