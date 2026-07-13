import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrg, setOrgConnectSql } from "./helpers";

// Registration v3 dual payments (spec 2026-07-12): the offline journey end to
// end (register → instructions → organiser Mark paid → confirmed), the card
// method's settings gate + payments_unavailable public state, and the
// no-payment waitlist promise. Real Stripe checkout is never driven here —
// the DB-backed vitest suite covers the webhook/refund contract.

async function seedPaidRig(
  request: APIRequestContext,
  opts: {
    feeCents: number;
    method?: "offline" | "stripe";
    instructions?: string | null;
    capacity?: number;
  },
) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Reg pay ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
    starts_on: "2026-09-15",
    ends_on: "2026-09-17",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Paid Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    },
  );
  const settings = await apiJson(
    request,
    `/api/v1/divisions/${div.data!.id}/registration-settings`,
    "PUT",
    {
      enabled: true,
      entrant_kind: "individual",
      fee_cents: opts.feeCents,
      currency: "gbp",
      capacity: opts.capacity ?? 10,
      form_fields: [],
      payment_method: opts.method ?? "offline",
      payment_instructions: opts.instructions ?? null,
    },
  );
  return {
    compId: comp.data!.id,
    compSlug: comp.data!.slug,
    divisionId: div.data!.id,
    divisionSlug: div.data!.slug,
    settingsStatus: settings.status,
  };
}

test("offline journey: instructions on the receipt, Mark paid confirms the entry", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const instructions = `Bank ${TAG} · sort 00-00-00 · ref your name`;
  const rig = await seedPaidRig(request, { feeCents: 1500, instructions });

  // Register through the public form — fee + method visible on the card.
  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await expect(page.getByText("pay the organiser")).toBeVisible();
  await page.getByRole("radio").first().check();
  await page.getByLabel(/Full name/).fill(`Cash Payer ${TAG}`);
  await page.getByLabel(/Contact email/).fill(`cash-${TAG}@example.com`);
  await page.getByRole("button", { name: /Enter — £15\.00/ }).click();

  // Receipt: held spot + the division's own instructions (org override).
  await page.waitForURL(/register\/status\?rid=/, { timeout: 20_000 });
  await expect(page.getByText("Registration received")).toBeVisible();
  await expect(page.getByText("How to pay your entry fee")).toBeVisible();
  await expect(page.getByText(instructions)).toBeVisible();

  // Organiser: the row shows due · cash, Mark paid confirms in one move.
  await page.goto(`/o/${org.slug}/c/${rig.compSlug}/d/${rig.divisionSlug}/registrations`);
  // v7 console: the list opens on Confirmed — the pending row sits under All.
  await page.getByTestId("reg-tab-all").click();
  await expect(page.getByTestId("payment-chip")).toHaveText("due · cash");
  await page.getByRole("button", { name: "Mark paid" }).click();
  await page.getByRole("button", { name: "Mark paid & confirm" }).click();
  await expect(page.getByTestId("payment-chip")).toHaveText("paid · cash", { timeout: 15_000 });
  await expect(page.getByText("entrant ✓")).toBeVisible();
});

test("card method: settings gate needs Connect, broken Connect closes the public division", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);

  // Without Connect the card method is rejected at save (422).
  await setOrgConnectSql(org.id, false);
  const rejected = await seedPaidRig(request, { feeCents: 500, method: "stripe" });
  expect(rejected.settingsStatus).toBe(422);

  // With Connect live the same save lands…
  await setOrgConnectSql(org.id, true);
  const rig = await seedPaidRig(request, { feeCents: 500, method: "stripe" });
  expect(rig.settingsStatus).toBe(200);

  // …and the public card advertises card payment.
  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await expect(page.getByText("pay by card at sign-up")).toBeVisible();
  await page.getByRole("radio").first().check();
  await expect(page.getByRole("button", { name: /Continue to payment — £5\.00/ })).toBeVisible();

  // Connect breaks afterwards → division closes with the honest reason.
  await setOrgConnectSql(org.id, false);
  await page.reload();
  await expect(page.getByText("card payments temporarily unavailable")).toBeVisible();
  await page.getByRole("radio").first().check();
  await expect(page.getByText("Card payments are temporarily unavailable")).toBeVisible();

  // Restore for sibling specs sharing the pro org.
  await setOrgConnectSql(org.id, true);
});

test("full paid division: waitlist promises no payment until promotion", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedPaidRig(request, { feeCents: 2000, capacity: 1 });
  await apiJson(
    request,
    `/api/v1/public/orgs/${org.slug}/competitions/${rig.compSlug}/register`,
    "POST",
    {
      division_id: rig.divisionId,
      display_name: "First In",
      contact_email: `first-pay-${TAG}@e.com`,
    },
  );

  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await page.getByRole("radio").first().check();
  await expect(page.getByText("Full — join the waitlist, pay only if promoted.")).toBeVisible();
  await page.getByLabel(/Full name/).fill("Wait Payer");
  await page.getByLabel(/Contact email/).fill(`waitpay-${TAG}@example.com`);
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await page.waitForURL(/register\/status\?rid=/, { timeout: 20_000 });
  await expect(page.getByText("no payment is taken while you wait")).toBeVisible();
});
