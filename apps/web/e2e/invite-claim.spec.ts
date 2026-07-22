import { test, expect } from "@playwright/test";
import { apiJson, activeOrg } from "./helpers";

// Email-invite auto-login (POST /api/invites/[token]/claim): a brand-new or
// unverified invitee is signed in AND joined in one step (the emailed invite
// proves the inbox — same trust as a magic link); a VERIFIED account is refused
// (needs_signin) so a forwarded invite can never take over a real account. The
// invitee is always a FRESH context — someone who has never authenticated.
test.describe("email invite auto-login (claim)", () => {
  async function emailInvite(page: import("@playwright/test").Page, orgId: string, role: string, email: string) {
    const invite = await apiJson<{ token: string }>(
      page.request,
      `/api/orgs/${orgId}/invites`,
      "POST",
      { role, email },
    );
    expect(invite.status).toBeLessThan(300);
    expect(invite.data?.token).toBeTruthy();
    return invite.data!.token;
  }

  // A genuinely anonymous visitor. `browser.newContext()` on its own inherits the
  // project storageState — the authed owner's session (playwright.config.ts) — so
  // a "fresh" context would silently carry seazn_session, and every assertion here
  // (session minted / refused, the anonymous one-tap UI) would pass vacuously
  // against the very behaviour it guards. Spell out empty storage.
  const anon = (b: import("@playwright/test").Browser) =>
    b.newContext({ storageState: { cookies: [], origins: [] } });

  test("a brand-new invitee is signed in and joined in one POST", async ({ page, browser }) => {
    const org = await activeOrg(page);
    const email = `e2e-claim-${Date.now()}@example.com`;
    const token = await emailInvite(page, org.id, "viewer", email);

    const ctx = await anon(browser);
    try {
      const res = await ctx.request.post(`/api/invites/${token}/claim`, { data: {} });
      expect(res.ok()).toBe(true);
      const body = ((await res.json()) as {
        data: { needs_signin: boolean; role: string; org_id: string };
      }).data;
      expect(body.needs_signin).toBe(false);
      expect(body.role).toBe("viewer");
      expect(body.org_id).toBe(org.id);
      // A session cookie was minted — the invitee is now logged in.
      const cookies = await ctx.cookies();
      expect(cookies.some((c) => c.name === "seazn_session")).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  test("a re-issued invite to a now-VERIFIED account will not auto-login", async ({ page, browser }) => {
    const org = await activeOrg(page);
    const email = `e2e-claim-verify-${Date.now()}@example.com`;

    // First claim creates the account and verifies the address.
    const first = await emailInvite(page, org.id, "viewer", email);
    const ctx1 = await anon(browser);
    try {
      const r1 = await ctx1.request.post(`/api/invites/${first}/claim`, { data: {} });
      const b1 = ((await r1.json()) as { data: { needs_signin: boolean } }).data;
      expect(b1.needs_signin).toBe(false);
    } finally {
      await ctx1.close();
    }

    // Re-issue to the same (now verified) address; a fresh visitor holding the
    // link must NOT be handed a session — this is the forwarded-invite guard.
    const second = await emailInvite(page, org.id, "admin", email);
    const ctx2 = await anon(browser);
    try {
      const r2 = await ctx2.request.post(`/api/invites/${second}/claim`, { data: {} });
      expect(r2.ok()).toBe(true);
      const b2 = ((await r2.json()) as { data: { needs_signin: boolean } }).data;
      expect(b2.needs_signin).toBe(true);
      const cookies = await ctx2.cookies();
      expect(cookies.some((c) => c.name === "seazn_session")).toBe(false);
    } finally {
      await ctx2.close();
    }
  });

  test("the join page one-tap button signs a new invitee in", async ({ page, browser }) => {
    const org = await activeOrg(page);
    const email = `e2e-claim-ui-${Date.now()}@example.com`;
    const token = await emailInvite(page, org.id, "viewer", email);

    const ctx = await anon(browser);
    try {
      const p = await ctx.newPage();
      await p.goto(`/join/${token}`);
      await p.getByRole("button", { name: "Accept invitation" }).click();
      // Left the join page, landed somewhere in the app, and holds a session.
      await expect(p).not.toHaveURL(/\/join\//, { timeout: 20_000 });
      const cookies = await ctx.cookies();
      expect(cookies.some((c) => c.name === "seazn_session")).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
