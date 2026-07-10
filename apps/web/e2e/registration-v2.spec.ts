import { test, expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// PROMPT-34 acceptance (v3/05): ordered-section form (#20 regression),
// individual/pair/team → tear-off ticket → /r/[ref], waitlist on a full
// division, organiser search-by-ref, token-gated self-withdraw, youth
// guardian preset + first-initial public names. The confirmation email's ref
// is asserted in the template unit test (Resend test mode isn't wired here).

interface DivSpec {
  name: string;
  entrant_kind: "individual" | "pair" | "team";
  capacity?: number;
  eligibility?: Record<string, unknown>[];
  form_fields?: { key: string; label: string; kind: "text"; required: boolean }[];
}

async function seedRegRig(request: APIRequestContext, divs: DivSpec[]) {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Reg v2 ${TAG} ${Math.random().toString(36).slice(2, 6)}`,
    visibility: "public",
    starts_on: "2026-09-15",
    ends_on: "2026-09-17",
  });
  const out: { id: string; slug: string; name: string }[] = [];
  for (const spec of divs) {
    const div = await apiJson<{ id: string; slug: string }>(
      request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: spec.name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
        eligibility: spec.eligibility ?? [],
      },
    );
    await apiJson(request, `/api/v1/divisions/${div.data!.id}/registration-settings`, "PUT", {
      enabled: true,
      entrant_kind: spec.entrant_kind,
      fee_cents: 0,
      currency: "gbp",
      capacity: spec.capacity ?? 10,
      form_fields: spec.form_fields ?? [],
    });
    out.push({ id: div.data!.id, slug: div.data!.slug, name: spec.name });
  }
  return { compId: comp.data!.id, compSlug: comp.data!.slug, divisions: out };
}

const REF_RE = /^SZ-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

test("individual registers through the ticket page; /r/[ref] resolves; withdraw is token-gated", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRegRig(request, [{ name: "Singles", entrant_kind: "individual" }]);

  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await page.getByRole("radio").first().check();
  await page.getByLabel(/Full name/).fill(`Walk In ${TAG}`);
  await page.getByLabel(/Contact email/).fill(`walkin-${TAG}@example.com`);
  await page.getByRole("button", { name: "Enter the competition" }).click();

  // Success screen = the tear-off ticket with the huge mono ref.
  await page.waitForURL(/register\/status\?rid=/, { timeout: 20_000 });
  const ref = (await page.getByTestId("ref-code").textContent())?.trim() ?? "";
  expect(ref).toMatch(REF_RE);
  await expect(page.getByRole("link", { name: "Check status" })).toBeVisible();

  // Public status by ref — masked-safe view, no withdraw without the token.
  await page.goto(`/r/${ref}`);
  await expect(page.getByTestId("ref-code")).toHaveText(ref);
  await expect(page.getByTestId("ref-status-line")).toContainText("pending review");
  await expect(page.getByRole("button", { name: "Withdraw my entry" })).toHaveCount(0);

  // Sloppy quoting still lands (lowercase, dashless).
  await page.goto(`/r/${ref.toLowerCase().replace(/-/g, "")}`);
  await expect(page.getByTestId("ref-code")).toHaveText(ref);

  // API self-withdraw without a valid token is rejected outright.
  const bad = await page.request.post(
    `/api/v1/public/registrations/by-ref/${encodeURIComponent(ref)}/withdraw`,
    { data: { token: "rg_not-the-real-token" } },
  );
  expect(bad.status()).toBe(404);
});

test("#20 regression: sections render identity → questions → consent → submit, in DOM order", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRegRig(request, [
    {
      name: "U16 Boys",
      entrant_kind: "individual",
      eligibility: [{ kind: "age", maxAgeAt: 15 }],
      form_fields: [{ key: "club", label: "Your club", kind: "text", required: true }],
    },
  ]);

  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await page.getByRole("radio").first().check();

  // Youth division: guardian consent renders without any DOB typed (gap 8).
  await expect(page.locator("[data-section='consent']")).toBeVisible();

  const order = await page.evaluate(() => {
    const keys = ["identity", "questions", "consent", "submit"];
    const els = keys.map((k) => document.querySelector(`[data-section="${k}"]`));
    if (els.some((e) => !e)) return "missing:" + keys.filter((_, i) => !els[i]).join(",");
    for (let i = 0; i < els.length - 1; i++) {
      const rel = els[i]!.compareDocumentPosition(els[i + 1]!);
      if (!(rel & Node.DOCUMENT_POSITION_FOLLOWING)) return `out-of-order at ${keys[i]}`;
    }
    return "ok";
  });
  expect(order).toBe("ok");
});

test("pair and team kinds submit with their own identity blocks", async ({ page, request }) => {
  const org = await activeOrg(page);
  const rig = await seedRegRig(request, [
    { name: "Doubles", entrant_kind: "pair" },
    { name: "Teams", entrant_kind: "team" },
  ]);
  const registerUrl = `/shared/${org.slug}/${rig.compSlug}/register`;

  // Pair: partner block joins the display name with '&'.
  await page.goto(registerUrl);
  await page.getByRole("radio").nth(0).check();
  await page.getByLabel(/Your name/).fill("Alex Pairman");
  await page.getByLabel(/Partner's name/).fill("Sam Partner");
  await page.getByLabel(/Contact email/).fill(`pair-${TAG}@example.com`);
  await page.getByRole("button", { name: "Enter the competition" }).click();
  await page.waitForURL(/register\/status\?rid=/, { timeout: 20_000 });
  await expect(page.getByText("Alex Pairman & Sam Partner")).toBeVisible();
  expect((await page.getByTestId("ref-code").textContent())?.trim()).toMatch(REF_RE);

  // Team: team name + optional roster.
  await page.goto(registerUrl);
  await page.getByRole("radio").nth(1).check();
  await page.getByLabel(/Team name/).fill(`FC ${TAG}`);
  await page.getByLabel(/Contact email/).fill(`team-${TAG}@example.com`);
  await page.getByRole("button", { name: "+ Add player" }).click();
  await page.getByLabel("Player 1 name").fill("Jordan Blake");
  await page.getByRole("button", { name: "Enter the competition" }).click();
  await page.waitForURL(/register\/status\?rid=/, { timeout: 20_000 });
  expect((await page.getByTestId("ref-code").textContent())?.trim()).toMatch(REF_RE);
});

test("full division flips to the waitlist state (an invitation, not a dead end)", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRegRig(request, [
    { name: "Tiny", entrant_kind: "individual", capacity: 1 },
  ]);
  // Fill the single spot via the API.
  await apiJson(
    request,
    `/api/v1/public/orgs/${org.slug}/competitions/${rig.compSlug}/register`,
    "POST",
    { division_id: rig.divisions[0]!.id, display_name: "First In", contact_email: `first-${TAG}@e.com` },
  );

  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await expect(page.getByText("full — joins the waitlist")).toBeVisible();
  await page.getByRole("radio").first().check();
  await expect(page.getByText("This division is full")).toBeVisible();
  await page.getByLabel(/Full name/).fill("Wait Lister");
  await page.getByLabel(/Contact email/).fill(`wait-${TAG}@example.com`);
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  await page.waitForURL(/register\/status\?rid=/, { timeout: 20_000 });
  await expect(page.getByText("You're on the waitlist")).toBeVisible();
});

test("organiser panel: ref column renders and search-by-ref finds the row", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRegRig(request, [{ name: "Lookup", entrant_kind: "individual" }]);
  const reg = await apiJson<{ ref_code: string }>(
    request,
    `/api/v1/public/orgs/${org.slug}/competitions/${rig.compSlug}/register`,
    "POST",
    {
      division_id: rig.divisions[0]!.id,
      display_name: "Findable Person",
      contact_email: `find-${TAG}@example.com`,
    },
  );
  const ref = reg.data!.ref_code;
  expect(ref).toMatch(REF_RE);

  await page.goto(`/o/${org.slug}/c/${rig.compSlug}/d/${rig.divisions[0]!.slug}/registrations`);
  await expect(page.getByText(ref)).toBeVisible({ timeout: 20_000 });

  // Search by a phone-quoted (lowercase, dashless) ref.
  await page.getByTestId("reg-search").fill(ref.toLowerCase().replace(/-/g, ""));
  await expect(page.getByText("Findable Person")).toBeVisible();
  await page.getByTestId("reg-search").fill("SZ-ZZZZ-ZZZZ");
  await expect(page.getByText("Findable Person")).toHaveCount(0);
});

test("youth division: public surfaces render first-initial names; open divisions keep full names", async ({
  page,
  request,
}) => {
  const org = await activeOrg(page);
  const rig = await seedRegRig(request, [
    {
      name: "U16 Public",
      entrant_kind: "individual",
      eligibility: [{ kind: "age", maxAgeAt: 15 }],
    },
    { name: "Open Public", entrant_kind: "individual" },
  ]);
  const [youthDiv, openDiv] = rig.divisions;

  for (const [div, names] of [
    [youthDiv!, ["Arun Kumar", "Dev Patel"]],
    [openDiv!, ["Grace Fulton", "Henry Adams"]],
  ] as const) {
    await apiJson(
      request,
      `/api/v1/divisions/${div.id}/entrants`,
      "POST",
      names.map((n, i) => ({ kind: "individual", display_name: n, seed: i + 1 })),
    );
  }

  const youth = await apiJson<{ entrants: { display_name: string }[] }>(
    request,
    `/api/v1/public/orgs/${org.slug}/competitions/${rig.compSlug}/divisions/${youthDiv!.slug}/entrants`,
  );
  const youthNames = youth.data!.entrants.map((e) => e.display_name).sort();
  expect(youthNames).toEqual(["Arun K.", "Dev P."]);

  const open = await apiJson<{ entrants: { display_name: string }[] }>(
    request,
    `/api/v1/public/orgs/${org.slug}/competitions/${rig.compSlug}/divisions/${openDiv!.slug}/entrants`,
  );
  expect(open.data!.entrants.map((e) => e.display_name).sort()).toEqual([
    "Grace Fulton",
    "Henry Adams",
  ]);

  // The consent section never renders on an open division without a minor
  // DOB. (Select by label — the register panel orders divisions by name.)
  await page.goto(`/shared/${org.slug}/${rig.compSlug}/register`);
  await page.getByRole("radio", { name: /Open Public/ }).check();
  await expect(page.locator("[data-section='consent']")).toHaveCount(0);
  await page.getByRole("radio", { name: /U16 Public/ }).check();
  await expect(page.locator("[data-section='consent']")).toBeVisible();
});
