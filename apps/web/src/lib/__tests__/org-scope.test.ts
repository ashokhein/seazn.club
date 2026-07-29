// v17 gap #334, the CLIENT half: the seams that write to group-scoped routes
// must put the org from the URL on the request. The server's preference for
// that header is proven against the real route in
// `app/api/billing/extra-orgs/__tests__/group-scope.test.ts`; if nothing ever
// SENDS it, the whole fix falls back to the cookie it was written to replace
// and every one of those tests still passes.
import { afterEach, describe, expect, it } from "vitest";
import { ORG_SCOPE_HEADER, orgScopeHeaders, orgSlugFromPath } from "@/lib/org-scope";
import { postJson } from "@/lib/api-post";
import { api } from "@/lib/client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The header a call actually went out with, or undefined. */
function sentScope(init: RequestInit | undefined): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[ORG_SCOPE_HEADER];
}

describe("orgSlugFromPath", () => {
  it("reads the org out of a console path, at any depth", () => {
    expect(orgSlugFromPath("/o/riverside")).toBe("riverside");
    expect(orgSlugFromPath("/o/riverside/settings/add-ons")).toBe("riverside");
    expect(orgSlugFromPath("/o/riverside-cc-2/settings/billing")).toBe("riverside-cc-2");
  });

  it("claims nothing outside the console tree", () => {
    // `/orgs/new` is the trap: a `/o/` prefix test would read "rgs" as a slug
    // and stamp a request made from a page that has no org at all.
    expect(orgSlugFromPath("/orgs/new")).toBeNull();
    expect(orgSlugFromPath("/admin/billing-events")).toBeNull();
    expect(orgSlugFromPath("/")).toBeNull();
    expect(orgSlugFromPath("/o/")).toBeNull();
    expect(orgSlugFromPath(null)).toBeNull();
    expect(orgSlugFromPath(undefined)).toBeNull();
  });

  it("refuses anything that is not slug-shaped", () => {
    expect(orgSlugFromPath("/o/Not A Slug")).toBeNull();
    expect(orgSlugFromPath("/o/%ZZ")).toBeNull();
    expect(orgSlugFromPath("/o/-leading-hyphen")).toBeNull();
  });

  it("builds no header off the console tree", () => {
    expect(orgScopeHeaders("/orgs/new")).toEqual({});
    expect(orgScopeHeaders("/o/acme")).toEqual({ [ORG_SCOPE_HEADER]: "acme" });
  });
});

describe("postJson names the org its page is about", () => {
  it("stamps the slug from the path it was called on", async () => {
    let seen: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return jsonResponse({ ok: true, data: { extraOrgs: 1 } });
    }) as unknown as typeof fetch;

    const result = await postJson(
      "/api/billing/extra-orgs",
      { count: 1 },
      fetchFn,
      "/o/northside/settings/add-ons",
    );

    expect(result.ok).toBe(true);
    expect(sentScope(seen)).toBe("northside");
  });

  it("sends no scope from a page that has no org in its URL", async () => {
    let seen: RequestInit | undefined;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return jsonResponse({ ok: true, data: {} });
    }) as unknown as typeof fetch;

    await postJson("/api/billing/extra-orgs", { count: 1 }, fetchFn, "/orgs/new");

    expect(sentScope(seen)).toBeUndefined();
  });
});

describe("api() names the org its page is about", () => {
  const realFetch = globalThis.fetch;
  const hadWindow = "window" in globalThis;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if (!hadWindow) delete (globalThis as { window?: unknown }).window;
  });

  it("stamps the slug from the live location", async () => {
    let seen: RequestInit | undefined;
    // `api()` has no injection seam — it is the app-wide helper every billing
    // control on the Billing tab (cancel, plan, interval, promo, address, tax
    // id, cards) goes through, so the location IS its input.
    (globalThis as { window?: unknown }).window = {
      location: { pathname: "/o/riverside/settings/billing" },
    };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return jsonResponse({ ok: true, data: {} });
    }) as unknown as typeof fetch;

    await api("/api/billing/cancel", { method: "POST", json: {} });

    expect(sentScope(seen)).toBe("riverside");
  });

  it("lets an explicit header win, so a caller can still choose", async () => {
    let seen: RequestInit | undefined;
    (globalThis as { window?: unknown }).window = {
      location: { pathname: "/o/riverside/settings/billing" },
    };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen = init;
      return jsonResponse({ ok: true, data: {} });
    }) as unknown as typeof fetch;

    await api("/api/billing/cancel", {
      method: "POST",
      json: {},
      headers: { [ORG_SCOPE_HEADER]: "northside" },
    });

    expect(sentScope(seen)).toBe("northside");
  });
});
