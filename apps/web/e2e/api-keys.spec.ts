import { test, expect } from "@playwright/test";
import { TAG, apiJson, activeOrg } from "./helpers";

// Platform API keys (Pro): mint → use with Bearer auth → revoke → rejected.
// Scopes are read < score < manage (v3/08 §2, PROMPT-37); a read key 403s on
// manage routes; community lacks api.access entirely.

const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";

test.describe.serial("api keys", () => {
  let orgId: string;
  let keyId: string;
  let secret: string;

  test("pro org mints a read key that authorises /api/v1", async ({ page, playwright }) => {
    orgId = (await activeOrg(page)).id;
    const created = await apiJson<{ id: string; secret: string }>(
      page.request,
      `/api/v1/orgs/${orgId}/api-keys`,
      "POST",
      { name: `e2e ${TAG}`, scopes: ["read"] },
    );
    expect(created.status).toBe(201);
    keyId = created.data!.id;
    secret = created.data!.secret;
    expect(secret.startsWith("sc_")).toBe(true);

    // The key alone (no cookies) reads the org's API.
    const keyApi = await playwright.request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
    });
    try {
      const res = await keyApi.get("/api/v1/competitions");
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    } finally {
      await keyApi.dispose();
    }
  });

  test("a read key is refused on manage routes (scope enforcement)", async ({ playwright }) => {
    const keyApi = await playwright.request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
    });
    try {
      const res = await keyApi.post("/api/v1/competitions", { data: { name: `Nope ${TAG}` } });
      expect(res.status()).toBe(403);
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message ?? "").toContain("manage");
    } finally {
      await keyApi.dispose();
    }
  });

  test("community orgs lack api.access", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: "e2e/.auth/community.json" });
    try {
      const cPage = await ctx.newPage();
      const communityOrg = await activeOrg(cPage);
      const res = await apiJson(cPage.request, `/api/v1/orgs/${communityOrg.id}/api-keys`, "POST", {
        name: `e2e ${TAG}`,
        scopes: ["read"],
      });
      expect(res.status).toBe(402);
    } finally {
      await ctx.close();
    }
  });

  test("a revoked key stops working", async ({ page, playwright }) => {
    const revoked = await page.request.delete(`/api/v1/orgs/${orgId}/api-keys/${keyId}`);
    expect(revoked.ok()).toBe(true);

    const keyApi = await playwright.request.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { Authorization: `Bearer ${secret}` },
    });
    try {
      const res = await keyApi.get("/api/v1/competitions");
      expect(res.status()).toBe(401);
    } finally {
      await keyApi.dispose();
    }
  });
});
