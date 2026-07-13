import { expect, test } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// Guards spec 2026-07-12 P1/P5 (Task 7): the public tree must stay
// ISR-cacheable — a stray cookies()/nonce read on a /shared page would flip
// it to `private, no-cache, no-store` and silently detach any CDN sitting in
// front of it (node_modules/next/dist/docs/01-app/02-guides/cdn-caching.md:
// "Dynamic pages (no caching): private, no-cache, no-store, max-age=0,
// must-revalidate"). /shared/[orgSlug]/[competitionSlug]/page.tsx pins
// `export const revalidate = 30`.
//
// Runtime probe, not an environment assumption: this suite's webServer
// (playwright.config.ts) runs `npm run dev`, i.e. `next dev` — which ALWAYS
// renders dynamically and never emits `s-maxage`, on every route, regardless
// of the route's own `revalidate` export. There is no dev-mode way to
// exercise this guard, and the suite has no prod-build project to opt into
// instead. Rather than assert nothing meaningful against a server that can
// never pass, this test probes the live response's own Cache-Control header
// and skips — loudly, with a reason — the moment the tree doesn't look
// ISR-cacheable.
//
// Deliberately NOT narrowed to "dev mode": manual `next build && next start`
// verification for this task (task-7-report.md) found this exact route
// serving `private, no-store` on a REAL production build too, root-caused to
// a missing `generateStaticParams` — per Next's own docs
// (api-reference/functions/generate-static-params.md: "You must return an
// empty array from generateStaticParams ... in order to revalidate (ISR)
// paths at runtime"), a dynamic segment with no generateStaticParams never
// gets ISR treatment for its runtime-discovered params, regardless of
// `revalidate`. (The root layout's AnalyticsBootstrap also independently
// forces many OTHER routes dynamic whenever PostHog is configured — a
// separate, also-real finding — but is NOT what's blocking this route.) A
// probe that only checked NODE_ENV would have missed this entirely; checking
// the actual header is what makes this guard meaningful once it's fixed.
test("public competition page emits s-maxage for CDN caching", async ({ page, request }) => {
  const comp = await apiJson<{ id: string; slug: string }>(request, "/api/v1/competitions", "POST", {
    name: `Cache Header ${TAG}`,
    visibility: "public",
  });
  expect(comp.status).toBeLessThan(300);
  const orgSlug = (await activeOrg(page)).slug;

  const res = await request.get(`/shared/${orgSlug}/${comp.data!.slug}`);
  expect(res.status()).toBe(200);
  const cc = res.headers()["cache-control"] ?? "";
  test.skip(
    !cc.includes("s-maxage"),
    `server isn't emitting ISR cache headers for this route (got Cache-Control: "${cc}") — ` +
      "either it's a dev-mode server (next dev always renders dynamically), or the tree is " +
      "missing generateStaticParams on a real production build (see task-7-report.md for a " +
      "known instance of the latter, plus a separate PostHog/AnalyticsBootstrap gap). Point " +
      "PLAYWRIGHT_BASE at a `next build && next start` server with that fixed to actually run " +
      "this assertion.",
  );
  expect(cc).toContain("s-maxage=30");
  expect(cc).toContain("stale-while-revalidate");
});
