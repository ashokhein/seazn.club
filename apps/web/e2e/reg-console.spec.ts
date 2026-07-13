import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// PROMPT-52 acceptance: the pulse strip and tab counts match a seeded
// division, the waitlist renders as a numbered queue in joined order, the
// token-gated status page shows "#N in line", and the public register card
// carries the waitlist count.

async function seedRig(request: APIRequestContext) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Reg console ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
    starts_on: "2026-09-15",
    ends_on: "2026-09-17",
  });
  const div = await apiJson<{ id: string; slug: string }>(
    request,
    `/api/v1/competitions/${comp.data!.id}/divisions`,
    "POST",
    {
      name: "Tiny Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      eligibility: [],
    },
  );
  await apiJson(request, `/api/v1/divisions/${div.data!.id}/registration-settings`, "PUT", {
    enabled: true,
    entrant_kind: "individual",
    fee_cents: 0,
    currency: "gbp",
    capacity: 1,
    form_fields: [],
  });
  return { compSlug: comp.data!.slug, divisionId: div.data!.id, divSlug: div.data!.slug };
}

test("pulse, queue order, #N in line, and public waitlist count all match one seeded division", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRig(request);

  const submit = (name: string, email: string) =>
    apiJson<{ registration_id: string; access_token: string }>(
      request,
      `/api/v1/public/orgs/${org.slug}/competitions/${rig.compSlug}/register`,
      "POST",
      { division_id: rig.divisionId, display_name: name, contact_email: email },
    );

  await submit("Holder One", `holder-${TAG}@e.com`); // takes the only spot (pending)
  await submit("Wait One", `w1-${TAG}@e.com`); // → waitlist #1
  const w2 = await submit("Wait Two", `w2-${TAG}@e.com`); // → waitlist #2

  // Organiser console: pulse numbers + tab counts from the same seed.
  await page.goto(`/o/${org.slug}/c/${rig.compSlug}/d/${rig.divSlug}/registrations`);
  await expect(page.getByTestId("pulse-holding")).toContainText("1", { timeout: 20_000 });
  await expect(page.getByTestId("pulse-waitlisted")).toContainText("2");
  await expect(page.getByTestId("reg-tab-pending")).toContainText("1");
  await expect(page.getByTestId("reg-tab-waitlist")).toContainText("2");

  // Waitlist tab renders the numbered queue in joined order.
  await page.getByTestId("reg-tab-waitlist").click();
  const positions = page.getByTestId("queue-position");
  await expect(positions).toHaveCount(2);
  await expect(positions.nth(0)).toHaveText("#1");
  await expect(positions.nth(1)).toHaveText("#2");
  const queueText = (await page.getByTestId("waitlist-queue").textContent()) ?? "";
  expect(queueText.indexOf("Wait One")).toBeLessThan(queueText.indexOf("Wait Two"));

  // The second waitlisted registrant's token page says #2 in line.
  await page.goto(
    `/shared/${org.slug}/${rig.compSlug}/register/status?rid=${w2.data!.registration_id}&token=${encodeURIComponent(w2.data!.access_token)}`,
  );
  await expect(page.getByTestId("queue-position-public")).toContainText("#2 in line");

  // Public register card shows the queue length behind the full division.
  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await expect(page.getByText("full — waitlist: 2")).toBeVisible();
});
