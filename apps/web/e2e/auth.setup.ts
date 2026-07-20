import { test as setup, expect, type Page } from "@playwright/test";
import {
  PROD_TARGET,
  mintLoginPathBySql,
  proEmail,
  communityEmail,
  setOrgPlanBySql,
  setEntitlementOverrideSql,
} from "./helpers";

const PRO_STATE = "e2e/.auth/pro.json";
const COMMUNITY_STATE = "e2e/.auth/community.json";

// Provision fresh accounts once (one Pro, one Community), then persist their
// logged-in cookies for the specs. Passwordless: request a magic link and open
// it in the browser to establish the session (an unknown email auto-creates
// the account), complete onboarding, then capture state. The Pro account is
// additionally flipped to the pro plan directly in the DB (DATABASE_URL
// required — same disposable DB the target server uses).
//
// NOTE the magic-link endpoint is rate-limited (5 per 5 min per IP, fail-
// closed) — these two setup links plus passwordless-login.spec.ts consume 3.
// Budget accordingly before adding specs that mint new users.
async function provision(page: Page, email: string): Promise<void> {
  let loginUrl: string | undefined;
  if (PROD_TARGET) {
    // Production target (e.g. staging): the route emails a real (bouncing)
    // address instead of dev-exposing the link — mint the token in the DB.
    loginUrl = await mintLoginPathBySql(email);
  } else {
    // Dev exposes the link as `login_url` so the flow is testable without email.
    const linkRes = await page.request.post("/api/auth/magic-link", { data: { email } });
    loginUrl = ((await linkRes.json()) as { data?: { login_url?: string } }).data?.login_url;
  }
  if (!loginUrl)
    throw new Error("magic-link login_url missing — dev server (non-production) required for e2e");

  // Opening the link consumes the token, signs in, and redirects (→ onboarding).
  await page.goto(loginUrl);
  await page.waitForURL((u) => !u.pathname.startsWith("/magic-link"), { timeout: 30_000 });

  // The browser context is now authenticated — drive setup through it.
  await page.request.post("/api/onboarding/complete", { data: {} });
  await page.request.post("/api/tour", { data: {} }).catch(() => undefined);
}

/** Confirm the app renders, pre-dismiss cookie consent, persist storage state. */
async function capture(page: Page, path: string): Promise<void> {
  await page.goto("/dashboard");
  // Two navs since PROMPT-30 (header + breadcrumb) — assert the header one.
  await expect(page.getByRole("navigation").first()).toBeVisible();

  // Pre-dismiss the cookie-consent banner. It renders app-wide (root layout)
  // and its fixed overlay intercepts pointer events, so without this the banner
  // would sit over buttons and fail clicks across the suite. "rejected" keeps
  // analytics off for tests. Both keys are required — the version stamp must
  // match COOKIE_POLICY_VERSION or the re-prompt logic reopens the banner.
  // Captured into storageState → reused by every spec.
  const { CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION } = await import(
    "../src/lib/consent"
  );
  await page.evaluate(
    ([k, vk, v]) => {
      localStorage.setItem(k, "rejected");
      localStorage.setItem(vk, v);
    },
    [CONSENT_KEY, CONSENT_VERSION_KEY, COOKIE_POLICY_VERSION] as const,
  );

  await page.context().storageState({ path });
}

setup("authenticate as a fresh Pro org", async ({ page }) => {
  const email = proEmail();
  await provision(page, email);
  // Pro plan → advanced entitlements resolve like a paying org.
  await setOrgPlanBySql({ email }, "pro");
  // The e2e run budgets 7 owned orgs for this shared user (see
  // playwright.config); the v3 pro cap is 3, so lift it via override —
  // exactly the grandfathering tool real over-cap owners get. Raised from 5
  // to 7 for the two trial-rule specs (burnt-trial CTA, staff grant).
  const orgs = (await (
    await page.request.get("/api/orgs")
  ).json()) as { data?: { id: string }[] };
  const setupOrgId = orgs.data?.[0]?.id;
  if (setupOrgId) await setEntitlementOverrideSql(setupOrgId, "orgs.max_owned", 7);
  await capture(page, PRO_STATE);
});

setup("authenticate as a fresh Community org", async ({ page }) => {
  const email = communityEmail();
  await provision(page, email);
  // No plan flip — new orgs default to the free community plan.
  await capture(page, COMMUNITY_STATE);
});
