import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// SPEC-2 news (PROMPT-83): on the shared Pro org, an opted-in division
// auto-drafts a result post on the decided seam. The organiser reviews it in the
// console News tab (⚡ auto chip), edits + publishes it, and the public feed +
// post page carry the scorebug, the share bar, and the downloadable story card.
// Serial: the second test reads the post the first one published.
test.describe.serial("org news", () => {
  let orgSlug: string;
  let postSlug: string;

  test("auto-draft → console review → publish → public scorebug", async ({ page }) => {
    const org = await activeOrg(page);
    orgSlug = org.slug;

    const comp = await apiJson<{ id: string; slug: string }>(
      page.request,
      "/api/v1/competitions",
      "POST",
      { name: `News E2E ${TAG}`, visibility: "public" },
    );
    const div = await apiJson<{ id: string; slug: string }>(
      page.request,
      `/api/v1/competitions/${comp.data!.id}/divisions`,
      "POST",
      {
        name: "News Prem",
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      },
    );
    const divId = div.data!.id;

    // Opt the division in (Pro news.auto on the shared org).
    const toggle = await apiJson(page.request, `/api/v1/divisions/${divId}`, "PATCH", {
      auto_posts: true,
    });
    expect(toggle.status).toBe(200);

    await apiJson(page.request, `/api/v1/divisions/${divId}/entrants`, "POST", [
      { kind: "individual", display_name: `Alpha ${TAG}`, seed: 1, members: [] },
      { kind: "individual", display_name: `Beta ${TAG}`, seed: 2, members: [] },
    ]);
    const stage = await apiJson<{ id: string }>(
      page.request,
      `/api/v1/divisions/${divId}/stages`,
      "POST",
      { seq: 1, kind: "league", name: "League" },
    );
    const gen = await apiJson<{ fixtures: { id: string }[] }>(
      page.request,
      `/api/v1/stages/${stage.data!.id}/generate`,
      "POST",
    );
    const fx = gen.data!.fixtures[0]!.id;
    await apiJson(page.request, `/api/v1/divisions/${divId}/start`, "POST");

    // Decide the fixture → the seam auto-drafts a result post.
    const st = await apiJson<{ last_seq: number }>(page.request, `/api/v1/fixtures/${fx}/state`);
    await apiJson(page.request, `/api/v1/fixtures/${fx}/events`, "POST", {
      expected_seq: st.data!.last_seq,
      type: "generic.result",
      payload: { p1Score: 3, p2Score: 1 },
    });

    // Console News tab: the ⚡ auto draft is queued.
    await page.goto(`/o/${orgSlug}/settings?tab=news`);
    await expect(page.getByTestId("news-tab")).toBeVisible();
    const draft = page.getByTestId("draft-row").first();
    await expect(draft).toBeVisible();
    await expect(draft.getByTestId("auto-chip")).toBeVisible();

    // Edit the headline (keep it a scoreline so it still renders a scorebug).
    await draft.getByRole("button", { name: /edit/i }).click();
    await expect(page.getByTestId("news-composer")).toBeVisible();
    await page.getByTestId("composer-title").fill(`Alpha ${TAG} 2–0 Beta ${TAG}`);
    await page.getByTestId("composer-save").click();

    // Publish from the drafts queue.
    await page.getByTestId("draft-row").first().getByTestId("draft-publish").click();
    await expect(page.getByTestId("published-row").first()).toBeVisible();
    postSlug = await page
      .getByTestId("published-row")
      .first()
      .getByRole("link")
      .first()
      .getAttribute("href")
      .then((h) => (h ?? "").split("/news/")[1] ?? "");
    expect(postSlug).not.toBe("");
  });

  test("public feed card, post scorebug, share bar + downloadable story card", async ({ page }) => {
    // Feed lists the published post as a card.
    await page.goto(`/shared/${orgSlug}/news`);
    await expect(page.getByTestId("news-card").first()).toBeVisible();

    // Post page: the scorebug hero + the share bar, and a working story.png.
    await page.goto(`/shared/${orgSlug}/news/${postSlug}`);
    await expect(page.getByTestId("post-scorebug")).toBeVisible();
    await expect(page.getByRole("link", { name: /whatsapp/i })).toBeVisible();

    const download = page.getByTestId("news-download-card");
    await expect(download).toBeVisible();
    const storyHref = await download.getAttribute("href");
    const png = await page.request.get(storyHref!);
    expect(png.status()).toBe(200);
    expect(png.headers()["content-type"]).toContain("image/png");
  });
});
