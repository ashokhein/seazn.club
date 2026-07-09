import { test, expect } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate, scoreFixture } from "./helpers";

// Bracket progression (the engine path the league journeys never touch):
// semi winners must flow into the final via winner_to slots, and the scoring
// ledger's optimistic concurrency must reject stale writes.

interface FixtureRow {
  id: string;
  round_no: number | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
  outcome?: { winner_entrant_id?: string | null } | null;
}

async function seedKnockoutDivision(request: Parameters<typeof apiJson>[0]) {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `KO ${TAG}-${Math.random().toString(36).slice(2, 6)}`,
    visibility: "private",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Cup",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  await addEntrantsViaApi(request, divisionId, ["Seed1", "Seed2", "Seed3", "Seed4"]);
  const { fixtureIds } = await createStageAndGenerate(request, divisionId, {
    kind: "knockout",
    name: "Cup",
  });
  await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  return { divisionId, fixtureIds };
}

async function getFixture(request: Parameters<typeof apiJson>[0], id: string) {
  return (await apiJson<FixtureRow>(request, `/api/v1/fixtures/${id}`)).data!;
}

test("knockout: semi winners advance into the final and decide the cup", async ({
  page,
  request,
}) => {
  const { divisionId, fixtureIds } = await seedKnockoutDivision(request);
  expect(fixtureIds.length).toBe(3); // 2 semis + final

  const fixtures = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  const semis = fixtures.filter((f) => f.home_entrant_id && f.away_entrant_id);
  const final = fixtures.find((f) => !f.home_entrant_id && !f.away_entrant_id);
  expect(semis.length).toBe(2);
  expect(final).toBeTruthy();

  // Home side wins both semis.
  const expectedFinalists = new Set(semis.map((s) => s.home_entrant_id!));
  for (const semi of semis) await scoreFixture(request, semi.id, 2, 0);

  // The final's slots fill from winner_to as each semi decides.
  await expect
    .poll(
      async () => {
        const f = await getFixture(request, final!.id);
        return [f.home_entrant_id, f.away_entrant_id].filter(Boolean).length;
      },
      { timeout: 20_000 },
    )
    .toBe(2);
  const filledFinal = await getFixture(request, final!.id);
  expect(expectedFinalists.has(filledFinal.home_entrant_id!)).toBe(true);
  expect(expectedFinalists.has(filledFinal.away_entrant_id!)).toBe(true);

  // Decide the cup; the fixtures tab shows the whole 3-match bracket.
  await scoreFixture(request, final!.id, 3, 1);
  const decidedFinal = await getFixture(request, final!.id);
  expect(["decided", "finalized"]).toContain(decidedFinal.status);

  await page.goto(`/divisions/${divisionId}?tab=fixtures`);
  await expect(page.getByRole("link", { name: /^(Score|View)/ })).toHaveCount(3, {
    timeout: 20_000,
  });
});

test("scoring rejects a stale expected_seq with 409 SEQ_CONFLICT", async ({ request }) => {
  const { fixtureIds } = await seedKnockoutDivision(request);
  const fixtures = await Promise.all(fixtureIds.map((id) => getFixture(request, id)));
  const semi = fixtures.find((f) => f.home_entrant_id && f.away_entrant_id)!;

  await scoreFixture(request, semi.id, 2, 0);

  // Replay the same write with the now-stale seq → optimistic concurrency 409.
  const stale = await apiJson(request, `/api/v1/fixtures/${semi.id}/events`, "POST", {
    expected_seq: 0,
    type: "generic.result",
    payload: { p1Score: 1, p2Score: 0 },
  });
  expect(stale.status).toBe(409);
  expect(stale.error?.code).toBe("SEQ_CONFLICT");
});
