import { test, expect } from "@playwright/test";
import { TAG, apiJson, addEntrantsViaApi, createStageAndGenerate } from "./helpers";

// Discovery: a public competition flagged discoverable shows up in the public
// discovery API and on /discover. Listing is free on every plan; the guard
// worth testing is that discoverable requires public visibility.
test("a discoverable public competition appears on /discover", async ({ page, request }) => {
  const name = `Discoverfest ${TAG}`;
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name,
    visibility: "public",
    starts_on: new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString().slice(0, 10),
  });
  // Discovery has a quality floor: the competition needs a decided fixture or
  // a division past setup — start a small league so it qualifies.
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Main",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  await addEntrantsViaApi(request, div.data!.id, ["Disc A", "Disc B"]);
  await createStageAndGenerate(request, div.data!.id);
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");

  const flagged = await apiJson(request, `/api/v1/competitions/${comp.data!.id}`, "PATCH", {
    discoverable: true,
    discovery: { country: "GB", tagline: "E2E open" },
  });
  expect(flagged.status).toBeLessThan(300);

  // Public JSON API lists it (anonymous).
  const found = await page.request.get(`/api/v1/public/discovery?q=${encodeURIComponent(name)}`);
  expect(found.status()).toBe(200);
  const items = ((await found.json()) as { data: { items: { name: string }[] } }).data.items;
  expect(items.some((i) => i.name === name)).toBe(true);

  // And the directory page renders its card.
  await page.goto(`/discover?q=${encodeURIComponent(name)}`);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });
});

test("discoverable requires public visibility", async ({ request }) => {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Hidden Fest ${TAG}`,
    visibility: "private",
  });
  const res = await apiJson(request, `/api/v1/competitions/${comp.data!.id}`, "PATCH", {
    discoverable: true,
  });
  expect(res.status).toBe(422);
});
