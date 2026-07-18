import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { activeOrg, createCompetitionViaUi, TAG } from "./helpers";

// Social-card regression net (PR #128 + home og:image fix). Two bugs it
// pins down: (1) the shared competition page emitted NO meta description /
// og:description / twitter:description when the competition had no
// description text — this Next build does not cascade the root layout's
// description; (2) the home page's page-level `openGraph` object replaced
// the inherited one wholesale, silently dropping the root file-convention
// og:image. Meta tags live in the server-rendered HTML, so assertions run
// on the fetched document, not the hydrated DOM.

function metaContent(html: string, attr: "name" | "property", key: string): string | null {
  // Next emits attribute orders both ways depending on the tag source.
  const a = html.match(new RegExp(`<meta[^>]*${attr}="${key}"[^>]*content="([^"]*)"`));
  const b = html.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*${attr}="${key}"`));
  return a?.[1] ?? b?.[1] ?? null;
}

async function expectFullSocialCard(
  request: APIRequestContext,
  path: string,
): Promise<void> {
  const res = await request.get(path);
  expect(res.status(), `${path} should render`).toBe(200);
  const html = await res.text();

  for (const [attr, key] of [
    ["name", "description"],
    ["property", "og:description"],
    ["name", "twitter:description"],
  ] as const) {
    expect(metaContent(html, attr, key), `${path} must emit ${key}`).toBeTruthy();
  }

  const image = metaContent(html, "property", "og:image");
  expect(image, `${path} must emit og:image`).toBeTruthy();
  // The host comes from siteOrigin() (env-dependent: prod fallback locally,
  // the real host on stg) — fetch the path against the server under test so
  // the assertion is host-agnostic and only proves the image route exists.
  const { pathname, search } = new URL(image!, res.url());
  const img = await request.get(pathname + search);
  expect(img.status(), `og:image of ${path} must be fetchable`).toBe(200);
  expect(img.headers()["content-type"], `og:image of ${path} must be an image`).toContain("image/");
}

test.describe("social cards (SEO meta)", () => {
  test("home emits a complete card including the root og:image", async ({ request }) => {
    await expectFullSocialCard(request, "/en");
  });

  test("marketing pages inherit the root card", async ({ request }) => {
    await expectFullSocialCard(request, "/pricing");
  });

  test("shared competition page emits a complete card even without a description", async ({
    page,
    request,
  }) => {
    // The wizard has no description field — exactly the state that used to
    // produce description: undefined and an empty card.
    await createCompetitionViaUi(page, `SEO Card ${TAG}`);
    const org = await activeOrg(page);
    const slug = page.url().match(/\/c\/([^/?]+)$/)![1]!;
    await expectFullSocialCard(request, `/shared/${org.slug}/${slug}`);
  });
});
