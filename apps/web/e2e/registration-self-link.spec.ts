import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg, loginUi, expectNoHorizontalScroll } from "./helpers";

/**
 * #402 — the headline regression, driven through the REAL public form.
 *
 * A signed-in visitor who ticks "I'm registering myself" and enters two
 * divisions must end up as ONE `persons` row. Everything below the browser is
 * already covered by unit tests; what only e2e can prove is that the checkbox
 * the organiser's registrant actually sees is wired to the affirmation the
 * server vetoes on — a component that rendered the control but never sent
 * `registering_self` would be green in every other suite.
 *
 * The identity assertion reads `person_id` off the entrants the organiser
 * confirmed (`GET /api/v1/entrants/{id}` is the only route that exposes it) and
 * cross-checks it against the registrant's own `/api/v1/me/persons`. Both
 * halves matter: entrant equality alone would also be satisfied by a person
 * that was never linked to the account, and `/me/persons` alone would be
 * satisfied by a link that the second division ignored.
 */
test("signed-in self-registration: two divisions resolve to one person", async ({
  page,
  request,
  browser,
}) => {
  // --- Organiser side: a public competition with TWO open divisions ---
  const comp = await apiJson<{ id: string; slug: string }>(
    request,
    "/api/v1/competitions",
    "POST",
    { name: `Self Link ${TAG}`, visibility: "public" },
  );
  const compId = comp.data!.id;
  const compSlug = comp.data!.slug;

  const divisionIds: string[] = [];
  for (const name of ["Lane A", "Lane B"]) {
    const div = await apiJson<{ id: string }>(
      request,
      `/api/v1/competitions/${compId}/divisions`,
      "POST",
      {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const divisionId = div.data!.id;
    const settings = await apiJson(
      request,
      `/api/v1/divisions/${divisionId}/registration-settings`,
      "PUT",
      {
        enabled: true,
        entrant_kind: "individual",
        capacity: 10,
        fee_cents: 0,
        currency: "gbp",
        form_fields: [],
      },
    );
    expect(settings.status).toBeLessThan(300);
    divisionIds.push(divisionId);
  }

  const orgSlug = (await activeOrg(page)).slug;
  const registerUrl = `/shared/${orgSlug}/${compSlug}/register`;
  const registrantEmail = `e2e-selflink-${TAG}@example.com`;
  const registrantName = `Self Link Runner ${TAG}`;

  // --- Registrant side: their own context, signed in, NOT the organiser ---
  // `next` is load-bearing (helpers.ts): a bare login auto-provisions an org
  // for a user who belongs to none, which would quietly make this player an
  // organiser and stop testing the visitor path.
  const regCtx = await browser.newContext();
  try {
    const reg = await regCtx.newPage();
    await loginUi(reg, registrantEmail, registerUrl);

    // The control is new UI, so it holds at the reference phone width too —
    // checked before any submission so it costs no extra registration.
    await reg.setViewportSize({ width: 375, height: 667 });
    await reg.goto(registerUrl);
    await reg.getByText("Lane A").first().click();
    await expect(reg.getByRole("checkbox", { name: /registering myself/i })).toBeVisible();
    await expectNoHorizontalScroll(reg);
    await reg.setViewportSize({ width: 1280, height: 800 });

    // Enter both divisions, affirming self-registration each time.
    for (const lane of ["Lane A", "Lane B"]) {
      await reg.goto(registerUrl);
      await reg.getByText(lane).first().click(); // division radio card
      await reg.getByLabel(/full name/i).fill(registrantName);
      await reg.getByLabel(/contact email/i).fill(registrantEmail);
      await reg.getByRole("checkbox", { name: /I agree that/ }).check();
      // #402 — the affirmation. Unchecked by default: the safe state is "no link".
      await reg.getByRole("checkbox", { name: /registering myself/i }).check();
      // …and the date of birth it makes mandatory. The server refuses to link an
      // undated registrant at all: without an age it cannot tell an adult
      // entering themselves from a parent entering a child, and two undated
      // children would otherwise fuse into one persons row.
      await reg.getByLabel(/^date of birth/i).fill("1990-05-05");
      await reg.getByRole("button", { name: "Enter the competition" }).click();
      await reg.waitForURL(/\/register\/status\?/, { timeout: 20_000 });
    }

    // --- Organiser confirms both; each confirm materialises an entrant ---
    const personIds: string[] = [];
    for (const divisionId of divisionIds) {
      const regs = await apiJson<{ id: string; status: string; display_name: string }[]>(
        request,
        `/api/v1/divisions/${divisionId}/registrations`,
      );
      const row = regs.data!.find((r) => r.display_name === registrantName);
      expect(row?.status).toBe("pending");

      const confirmed = await apiJson<{ entrant_id: string | null }>(
        request,
        `/api/v1/registrations/${row!.id}/confirm`,
        "POST",
        {},
      );
      expect(confirmed.status).toBeLessThan(300);
      const entrantId = confirmed.data!.entrant_id;
      expect(entrantId).toBeTruthy();

      const entrant = await apiJson<{ members: { person_id: string }[] }>(
        request,
        `/api/v1/entrants/${entrantId}`,
      );
      expect(entrant.data!.members).toHaveLength(1);
      personIds.push(entrant.data!.members[0]!.person_id);
    }

    // The headline: one human, two divisions, ONE person row.
    expect(personIds[0]).toBeTruthy();
    expect(personIds[1]).toBe(personIds[0]);

    // …and that person is the registrant's own, not an unlinked duplicate that
    // both entrants happen to share. /me/persons selects on persons.user_id.
    const mine = await apiJson<{ id: string }[]>(reg.request, "/api/v1/me/persons");
    expect(mine.status).toBe(200);
    expect(mine.data!.filter((p) => p.id === personIds[0])).toHaveLength(1);
  } finally {
    await regCtx.close();
  }
});
