import { test, expect } from "@playwright/test";
import { apiJson, activeOrg } from "./helpers";

// Membership lifecycle without spending magic links: invites are share-link
// tokens returned by the create API, and the second session is the existing
// Community account (its storage state file), not a fresh user.
// Serial: later tests reuse the membership created earlier.
test.describe.serial("members and roles", () => {
  const COMMUNITY_STATE = "e2e/.auth/community.json";
  let proOrgId: string;
  let communityUserId: string;

  test("an invite link grants viewer membership", async ({ page, browser }) => {
    proOrgId = (await activeOrg(page)).id;

    const invite = await apiJson<{ token: string; role: string }>(
      page.request,
      `/api/orgs/${proOrgId}/invites`,
      "POST",
      { role: "viewer", max_uses: 1 },
    );
    expect(invite.status).toBeLessThan(300);
    expect(invite.data?.token).toBeTruthy();

    // Accept as the Community account (separate session, no new magic link).
    const communityCtx = await browser.newContext({ storageState: COMMUNITY_STATE });
    try {
      const accepted = await communityCtx.request.post(`/api/invites/${invite.data!.token}/accept`, {
        data: {},
      });
      expect(accepted.ok()).toBe(true);
      // /api/* handlers wrap results in the { ok, data } envelope too.
      const body = ((await accepted.json()) as { data: { org_id: string; role: string } }).data;
      expect(body.org_id).toBe(proOrgId);
      expect(body.role).toBe("viewer");
    } finally {
      await communityCtx.close();
    }

    // The owner's member list now shows the viewer.
    const members = await apiJson<{ user_id: string; role: string; email: string }[]>(
      page.request,
      `/api/orgs/${proOrgId}/members`,
    );
    const viewer = members.data!.find((m) => m.email.startsWith("e2e-community-"));
    expect(viewer?.role).toBe("viewer");
    communityUserId = viewer!.user_id;
  });

  test("the owner can promote a member to admin", async ({ page }) => {
    const res = await apiJson(
      page.request,
      `/api/orgs/${proOrgId}/members/${communityUserId}/role`,
      "POST",
      { role: "admin" },
    );
    expect(res.status).toBeLessThan(300);

    // The Team tab reflects the role and offers invite management.
    await page.goto("/settings?tab=team");
    await expect(page.getByRole("button", { name: "+ Create link" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/e2e-community-/).first()).toBeVisible();
  });

  test("ownership transfers and returns (community org)", async ({ page, browser }) => {
    // Play it out on the COMMUNITY org so the shared Pro org's owner never
    // changes: community owner invites the Pro user, transfers to them, and
    // the Pro session hands it straight back.
    const communityCtx = await browser.newContext({ storageState: COMMUNITY_STATE });
    try {
      const cPage = await communityCtx.newPage();
      const communityOrg = await activeOrg(cPage);

      const invite = await apiJson<{ token: string }>(
        cPage.request,
        `/api/orgs/${communityOrg.id}/invites`,
        "POST",
        { role: "admin", max_uses: 1 },
      );
      const accepted = await page.request.post(`/api/invites/${invite.data!.token}/accept`, {
        data: {},
      });
      expect(accepted.ok()).toBe(true);

      const members = await apiJson<{ user_id: string; email: string; role: string }[]>(
        cPage.request,
        `/api/orgs/${communityOrg.id}/members`,
      );
      const proMember = members.data!.find((m) => m.email.startsWith("e2e-pro-"))!;
      const communityOwner = members.data!.find((m) => m.email.startsWith("e2e-community-"))!;

      // Community owner → Pro user.
      const away = await apiJson(
        cPage.request,
        `/api/orgs/${communityOrg.id}/transfer-owner`,
        "POST",
        { new_owner_id: proMember.user_id },
      );
      expect(away.status).toBeLessThan(300);

      // …and straight back, from the Pro session (now the owner).
      const back = await apiJson(
        page.request,
        `/api/orgs/${communityOrg.id}/transfer-owner`,
        "POST",
        { new_owner_id: communityOwner.user_id },
      );
      expect(back.status).toBeLessThan(300);

      const after = await apiJson<{ user_id: string; role: string }[]>(
        cPage.request,
        `/api/orgs/${communityOrg.id}/members`,
      );
      expect(after.data!.find((m) => m.user_id === communityOwner.user_id)?.role).toBe("owner");
      expect(after.data!.find((m) => m.user_id === proMember.user_id)?.role).toBe("admin");
    } finally {
      await communityCtx.close();
    }
  });

  test("the owner can remove a member", async ({ page }) => {
    const res = await page.request.delete(`/api/orgs/${proOrgId}/members/${communityUserId}`);
    expect(res.ok()).toBe(true);

    const members = await apiJson<{ user_id: string }[]>(
      page.request,
      `/api/orgs/${proOrgId}/members`,
    );
    expect(members.data!.some((m) => m.user_id === communityUserId)).toBe(false);
  });
});
