import { test as setup, expect } from "@playwright/test";
import { proEmail, PASSWORD } from "./helpers";

const AUTH_STATE = "e2e/.auth/pro.json";

// Provision a fresh Pro account once, then persist its logged-in cookies for
// every other spec. Signup → verify → onboarding via the app's own endpoints,
// pro subscription flipped directly in the DB (DATABASE_URL required — same
// disposable DB the target server uses), then a real UI login to capture the
// browser session.
setup("authenticate as a fresh Pro org", async ({ page, request }) => {
  const email = proEmail();

  const signup = await request.post("/api/auth/signup", {
    data: { email, password: PASSWORD },
  });
  const reg = (await signup.json()) as { data?: { verify_token?: string }; verify_token?: string };
  const verifyToken = reg.data?.verify_token ?? reg.verify_token;
  await request.post("/api/auth/verify-email", { data: { token: verifyToken } });
  await request.post("/api/onboarding/complete", {});
  await request.post("/api/tour", {}).catch(() => undefined);

  // Pro plan → advanced entitlements resolve like a paying org.
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required to set the org's plan to pro for e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    ssl:
      process.env.DATABASE_SSL === "disable"
        ? false
        : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)
          ? false
          : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  await sql`
    with org as (
      select m.org_id from org_members m join users u on u.id = m.user_id
      where u.email = ${email} limit 1)
    insert into subscriptions (org_id, plan_key, status)
    select org_id, 'pro', 'active' from org
    on conflict (org_id) do update set plan_key = 'pro', status = 'active'`;
  await sql.end();

  // Real UI login → capture the browser storage state.
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.locator("form").getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  await expect(page.getByRole("navigation")).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE });
});
