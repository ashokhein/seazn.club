import { test, expect } from "@playwright/test";
import { TAG, apiJson } from "./helpers";

// Unified Add-Entrant: enroll an EXISTING team into a division from the UI
// (the "Existing team" mode), instead of re-running the CSV import.
test("enroll an existing team into a division via the UI", async ({ page }) => {
  // Seed a team by importing it (no Division column → directory only, no entry).
  const csv = `Club,Team,Player\nRiverside ${TAG},Riverside U12 ${TAG},Ada ${TAG}`;
  const up = await page.request.post("/api/v1/imports", {
    multipart: { file: { name: "p.csv", mimeType: "text/csv", buffer: Buffer.from(csv) } },
  });
  const importId = ((await up.json()) as { data: { importId: string } }).data.importId;
  await page.request.post(`/api/v1/imports/${importId}/commit`, { data: {} });

  // A competition + division to enroll into.
  const comp = (await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    name: `Enroll ${TAG}`,
    visibility: "public",
  })).data!;
  const div = (await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    },
  )).data!;

  // Give the club a crest so the badge-fallback contract is observable: the
  // team has no own logo, so its entrant row must wear the CLUB crest.
  const clubs = (await apiJson<{ id: string; name: string }[]>(page.request, "/api/v1/clubs")).data!;
  const club = clubs.find((c) => c.name === `Riverside ${TAG}`)!;
  await apiJson(page.request, `/api/v1/clubs/${club.id}`, "PATCH", {
    logo_path: "orgs/e2e/clubs/enroll-crest.png",
  });

  await page.goto(`/divisions/${div.id}?tab=entrants`);
  await page.getByRole("button", { name: "Existing team" }).click();
  await page.getByRole("textbox", { name: "Search teams" }).fill(`Riverside U12 ${TAG}`);
  await page.getByText(`Riverside U12 ${TAG}`, { exact: true }).first().click();
  await page.getByRole("button", { name: /Enroll team/ }).click();

  // The team now appears as an entrant in the division table.
  const cell = page.getByRole("cell", { name: `Riverside U12 ${TAG}` });
  await expect(cell).toBeVisible();

  // Clubs W1 regression 1: the row wears the club crest (entrant has no own
  // badge, team has no own logo — the resolved logo map must fall through).
  await expect(cell.locator('img[src*="enroll-crest.png"]')).toBeVisible();

  // Clubs W1 regression 2: first-time enrollment seeded the roster from the
  // team's squad — the imported player is already on the entrant.
  await cell.getByRole("button", { name: new RegExp(`Riverside U12 ${TAG}`) }).click();
  await expect(page.getByText(`Ada ${TAG}`)).toBeVisible();
});

// Enrollment snapshots the squad ONCE; players added to the squad afterwards
// don't appear on the entry until the organiser syncs explicitly. This covers
// the empty-squad warning in the enroll form and the "Sync from team squad"
// action on the entrant row.
test("empty-squad enroll warns, then Sync from team squad pulls late players", async ({ page }) => {
  const teamName = `Latecomers ${TAG}`;
  const team = (await apiJson<{ id: string }>(page.request, "/api/v1/teams", "POST", {
    name: teamName,
  })).data!;

  const comp = (await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    name: `Sync ${TAG}`,
    visibility: "private",
  })).data!;
  const div = (await apiJson<{ id: string }>(
    page.request,
    `/api/v1/competitions/${comp.id}/divisions`,
    "POST",
    {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    },
  )).data!;

  // Enroll form: picking the squad-less team surfaces the empty-squad warning.
  await page.goto(`/divisions/${div.id}?tab=entrants`);
  await page.getByRole("button", { name: "Existing team" }).click();
  await page.getByRole("textbox", { name: "Search teams" }).fill(teamName);
  await page.getByText(teamName, { exact: true }).first().click();
  await expect(page.getByTestId("squad-preview")).toContainText("Team squad is empty");
  await page.getByRole("button", { name: /Enroll team/ }).click();
  const cell = page.getByRole("cell", { name: teamName });
  await expect(cell).toBeVisible();

  // Squad filled AFTER enrollment; the entry roster is still the empty snapshot.
  const person = (await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
    full_name: `Late Joiner ${TAG}`,
    consent: {},
    dob: null,
    gender: null,
    external_ref: null,
  })).data!;
  await apiJson(page.request, `/api/v1/teams/${team.id}/squad`, "PUT", {
    members: [
      { person_id: person.id, squad_number: 9, default_position_key: null, is_captain: false, roles: [] },
    ],
  });

  // Expand the row → Sync from team squad → confirm → the late player appears.
  await cell.getByRole("button", { name: new RegExp(teamName) }).click();
  await page.getByRole("button", { name: "Sync from team squad" }).click();
  await page.getByRole("button", { name: "Sync roster" }).click();
  await expect(page.getByText(`Late Joiner ${TAG}`)).toBeVisible();
});
