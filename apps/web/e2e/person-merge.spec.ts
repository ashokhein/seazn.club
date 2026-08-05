import { test, expect, type Page } from "@playwright/test";
import { loginUi, activeOrg, apiJson, failOnNativeDialog } from "./helpers";

/**
 * #404 — the organiser's whole duplicate journey, against a real schema:
 * open the queue, confirm a suggested pair, see the survivor on the roster and
 * the duplicate gone, undo from the merge log, see both records back.
 *
 * Everything before this ran against stubbed props or a seeded usecase. This is
 * the only check that the page a signed-in organiser actually loads is wired to
 * the routes that do the work — and the only place the CONSENT resolution is
 * asserted as something a human can read rather than as a column value.
 *
 * Own empty storageState + `loginUi` + a fresh org, deliberately: the shared Pro
 * org accumulates hundreds of persons across a run and the roster page loads
 * only the oldest 200 (`listPersons` is `order by created_at`), so a pair
 * created late in a shared org can be genuinely correct and simply off the page.
 * A fresh org also makes the queue's own count assertable — in a borrowed org
 * "a candidate is listed" cannot distinguish mine from somebody else's.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const STAMP = Date.now().toString(36);
// One human, two records. The names must fold identically — a shared normalised
// name is the queue's entry ticket — so the external reference is the only thing
// that tells the two rows apart on screen, and it is what every roster assertion
// below keys on.
const NAME = `Ines Okonkwo ${STAMP}`;
const KEEP_REF = `keep-${STAMP}`;
const DUPE_REF = `dupe-${STAMP}`;

const roster = (page: Page) => page.getByRole("table", { name: "Players" });
const queue = (page: Page) => page.getByRole("region", { name: "Possible duplicates" });

test("an organiser merges a suggested duplicate, then undoes it", async ({ page }) => {
  failOnNativeDialog(page);

  await loginUi(page, `dupmerge-${STAMP}@example.com`, "/");
  const created = await apiJson<{ id: string }>(page.request, "/api/orgs", "POST", {
    name: `Duplicate Review ${STAMP}`,
  });
  expect(created.status).toBeLessThan(300);
  await apiJson(page.request, "/api/orgs/active", "POST", { org_id: created.data!.id });
  await activeOrg(page);

  // `public_photo` agrees and `public_name` does not: a consent pair that
  // disagrees is the only shape that can tell "the stricter setting wins" from
  // "the survivor's setting wins" or "every flag is turned off".
  const mk = async (ref: string, consent: Record<string, boolean>) => {
    const res = await apiJson<{ id: string }>(page.request, "/api/v1/persons", "POST", {
      full_name: NAME,
      external_ref: ref,
      consent,
    });
    expect(res.status, `create person ${ref}`).toBe(201);
    return res.data!.id;
  };
  const keepId = await mk(KEEP_REF, { public_name: true, public_photo: true });
  const dupeId = await mk(DUPE_REF, { public_name: false, public_photo: true });

  // --- 1. The queue offers the pair, and says why.
  await page.goto("/directory?tab=players", { waitUntil: "load" });
  // The exact orientation is the contract, not an accident: the usecase orders
  // the pair `(a.created_at, a.id) < (b.…)`, so the older row is always the
  // proposed survivor, and the organiser's cursor never moves between seeing a
  // pair and confirming it.
  const card = queue(page).locator(`[data-candidate="${keepId}:${dupeId}"]`);
  await expect(card).toBeVisible();
  await expect(queue(page).locator("[data-dupes-count]")).toHaveAttribute("data-dupes-count", "1");
  await expect(card.locator('[data-evidence-kind="name"]')).toHaveAttribute(
    "data-evidence-on",
    "true",
  );
  // Two records, one human: nothing here suggested itself on a date of birth.
  await expect(card.locator('[data-evidence-kind="dob"]')).toHaveAttribute(
    "data-evidence-on",
    "false",
  );

  // Both records are on the roster before anything is merged. Without this the
  // "duplicate is gone" assertion below is satisfied by a roster that never
  // held it.
  await expect(roster(page).getByText(KEEP_REF)).toBeVisible();
  await expect(roster(page).getByText(DUPE_REF)).toBeVisible();

  // --- 1b. The same queue at a phone width. Only `mobile.spec.ts` is run by the
  // mobile projects, so a surface that must hold at 375px checks itself here.
  await page.setViewportSize({ width: 375, height: 800 });
  await expect(card).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    ),
    "no horizontal page scroll at 375px on /directory?tab=players",
  ).toBe(false);
  await page.setViewportSize({ width: 1280, height: 800 });

  // --- 2. The confirmation states what the merge will do to consent.
  await card.getByRole("button", { name: "Review" }).click();
  const confirm = page.getByRole("dialog", { name: "Merge two records" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(KEEP_REF)).toBeVisible();
  await expect(confirm.getByText(DUPE_REF)).toBeVisible();
  await expect(confirm.getByText("Nothing is deleted. You can undo this merge at any time."))
    .toBeVisible();
  // One record hid the name → the merged record hides it. Both allowed the
  // photo → the merged record keeps it.
  await expect(confirm.locator('[data-consent-key="public_name"]')).toHaveAttribute(
    "data-resolved",
    "off",
  );
  await expect(confirm.locator('[data-consent-key="public_photo"]')).toHaveAttribute(
    "data-resolved",
    "on",
  );

  // The merge cannot be reached without the organiser affirming it — the same
  // refusal the route serves as 422 MERGE_NOT_CONFIRMED, here as a dead button.
  const mergeButton = confirm.locator('[data-merge-confirm="1"]');
  await expect(mergeButton).toBeDisabled();
  await confirm.locator('[data-affirm="1"]').check();
  await expect(mergeButton).toBeEnabled();
  await mergeButton.click();

  // --- 3. The outcome names the survivor, and the roster agrees.
  const outcome = page.getByText(`Merged into ${NAME}`);
  await expect(outcome).toBeVisible();
  await page.locator(".modal").getByRole("button", { name: "Close", exact: true }).click();

  await expect(roster(page).getByText(DUPE_REF)).toHaveCount(0);
  await expect(roster(page).getByText(KEEP_REF)).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(queue(page).locator("[data-dupes-empty]")).toBeVisible();

  // --- 4. Undo from the merge log — which survived the page refresh the merge
  // triggered, so this is the durable log and not a toast.
  const entry = page.locator("[data-merge-entry]").filter({ hasText: NAME });
  await expect(entry).toHaveCount(1);
  await entry.getByRole("button", { name: "Undo" }).click();
  const undo = page.getByRole("dialog", { name: "Undo this merge?" });
  await expect(undo).toBeVisible();
  await undo.locator('[data-reverse-confirm="1"]').click();

  // --- 5. Both records are back, and the log still remembers what happened.
  await expect(roster(page).getByText(DUPE_REF)).toBeVisible();
  await expect(roster(page).getByText(KEEP_REF)).toBeVisible();
  await expect(entry.getByText("Undone")).toBeVisible();
  // Reversed, not erased: the pair is a live duplicate again.
  await expect(queue(page).locator(`[data-candidate="${keepId}:${dupeId}"]`)).toBeVisible();
});
