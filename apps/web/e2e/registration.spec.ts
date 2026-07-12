import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// Public registration: organiser opens free registration on a division, an
// anonymous visitor registers through the public form (status page reached via
// the access_token in the URL — no email involved), and the organiser
// confirms the registration into a real entrant.
test("public registration: open → register → confirm to entrant", async ({
  page,
  request,
  browser,
}) => {
  // Organiser side: public competition + division with registration enabled.
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Open Day ${TAG}`,
    visibility: "public",
  });
  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Singles",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    },
  );
  const divisionId = div.data!.id;
  const settings = await apiJson(request, `/api/v1/divisions/${divisionId}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    capacity: 10,
    fee_cents: 0,
    currency: "gbp",
    form_fields: [],
  });
  expect(settings.status).toBeLessThan(300);

  const orgSlug = (await activeOrg(page)).slug;

  // Anonymous visitor registers through the public form.
  const anonCtx = await browser.newContext();
  try {
    const anon = await anonCtx.newPage();
    await anon.goto(`/shared/${orgSlug}/${comp.data!.slug}/register`);
    await anon.getByText("Singles").first().click(); // division radio card
    await anon.getByLabel(/full name/i).fill(`Reg Runner ${TAG}`);
    await anon.getByLabel(/contact email/i).fill(`e2e-reg-${TAG}@example.com`);
    // Registration v2 (PROMPT-34) renamed the submit CTA.
    await anon.getByRole("button", { name: "Enter the competition" }).click();

    // Free registrations land on the tokenised status page.
    await anon.waitForURL(/\/register\/status\?/, { timeout: 20_000 });
    await expect(anon.getByText(new RegExp(`Reg Runner ${TAG}|pending|received`, "i")).first()).toBeVisible(
      { timeout: 20_000 },
    );
  } finally {
    await anonCtx.close();
  }

  // Organiser sees it pending and confirms it into an entrant.
  const regs = await apiJson<{ id: string; status: string; display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/registrations`,
  );
  const reg = regs.data!.find((r) => r.display_name === `Reg Runner ${TAG}`);
  expect(reg?.status).toBe("pending");

  const confirmed = await apiJson(request, `/api/v1/registrations/${reg!.id}/confirm`, "POST", {});
  expect(confirmed.status).toBeLessThan(300);

  const entrants = await apiJson<{ display_name: string }[]>(
    request,
    `/api/v1/divisions/${divisionId}/entrants`,
  );
  expect(entrants.data!.some((e) => e.display_name === `Reg Runner ${TAG}`)).toBe(true);
});
