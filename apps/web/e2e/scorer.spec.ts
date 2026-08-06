import { test, expect } from "@playwright/test";
import {
  TAG,
  apiJson,
  activeOrg,
  divisionPath,
  fixturePath,
  loginUi,
  seedScoredDivision,
} from "./helpers";

// Scorer seat: a scorer invite with a division default_scope both creates the
// membership AND the scorer_assignments row (there is no separate assign API).
// The scorer is a fresh user — this spec spends ONE magic link; the org's
// scorers.max on Pro is 1, so it is also the only scorer spec.
test.describe.serial("scorer routing and scoring surface", () => {
  const scorerEmail = `e2e-scorer-${TAG}@example.com`;
  let divisionId: string;
  /** The division's slug chain, resolved by the ORGANISER in the first test.
   *  The scorer cannot resolve it — refusing them that page is what the 404
   *  below asserts — so the address has to be carried across. */
  let divisionHref: string;
  let fixtureId: string;
  let inviteToken: string;

  test("organiser mints a division-scoped scorer invite", async ({ page, request }) => {
    // Timed, undecided fixtures — the scorer's my-matches feed only lists
    // scheduled/in-play fixtures.
    const seeded = await seedScoredDivision(request, ["Kick", "Snare", "Hat", "Tom"], {
      decide: false,
    });
    divisionId = seeded.divisionId;
    divisionHref = await divisionPath(request, divisionId);

    const orgId = (await activeOrg(page)).id;
    const invite = await apiJson<{ token: string }>(page.request, `/api/orgs/${orgId}/invites`, "POST", {
      role: "scorer",
      max_uses: 1,
      default_scope: { type: "division", id: divisionId },
    });
    expect(invite.status).toBeLessThan(300);
    inviteToken = invite.data!.token;
  });

  // `request` is the ORGANISER's context — the only one that can turn a
  // fixture id into its slug chain for an account the console refuses.
  test("scorer lands on my-matches with the assigned fixtures", async ({ browser, request }) => {
    const ctx = await browser.newContext(); // clean session for the new user
    const page = await ctx.newPage();
    try {
      await loginUi(page, scorerEmail);
      const accepted = await page.request.post(`/api/invites/${inviteToken}/accept`, { data: {} });
      expect(accepted.ok()).toBe(true);
      // /api/* handlers wrap results in the { ok, data } envelope.
      expect(((await accepted.json()) as { data: { landing: string } }).data.landing).toBe(
        "/my-matches",
      );

      // Organiser pages bounce a scorer to /my-matches…
      await page.goto("/dashboard");
      await page.waitForURL(/\/my-matches/, { timeout: 20_000 });
      await expect(page.getByRole("heading", { name: "My matches" })).toBeVisible();

      // …which lists the division's fixtures (assignment came from the invite scope).
      const assigned = await page.request.get("/api/v1/me/assigned-fixtures");
      const list = ((await assigned.json()) as { data: { id: string }[] }).data ?? [];
      expect(list.length).toBeGreaterThan(0);
      fixtureId = list[0]!.id;
      await expect(page.getByRole("link").filter({ hasText: /Kick|Snare|Hat|Tom/ }).first()).toBeVisible(
        { timeout: 20_000 },
      );

      // Organiser console is invisible to a scorer: the division's own address
      // 404s. Resolved by the organiser above, so this is the page refusing
      // them rather than a URL that does not exist.
      const res = await page.goto(divisionHref);
      expect(res!.status()).toBe(404);

      // The assigned fixture's scoring surface opens fine.
      await page.goto(await fixturePath(request, fixtureId));
      await expect(page.getByText(/Kick|Snare|Hat|Tom/).first()).toBeVisible({ timeout: 20_000 });
    } finally {
      await ctx.close();
    }
  });
});
