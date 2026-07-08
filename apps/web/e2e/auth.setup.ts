import { test as setup, expect } from "@playwright/test";
import { proEmail } from "./helpers";

const AUTH_STATE = "e2e/.auth/pro.json";

// Provision a fresh Pro account once, then persist its logged-in cookies for
// every other spec. Passwordless: request a magic link and open it in the
// browser to establish the session (an unknown email auto-creates the account),
// complete onboarding, flip the org to Pro directly in the DB (DATABASE_URL
// required — same disposable DB the target server uses), then capture state.
setup("authenticate as a fresh Pro org", async ({ page, request }) => {
  const email = proEmail();

  // Dev exposes the link as `login_url` so the flow is testable without email.
  const linkRes = await request.post("/api/auth/magic-link", { data: { email } });
  const loginUrl = ((await linkRes.json()) as { data?: { login_url?: string } }).data
    ?.login_url;
  if (!loginUrl)
    throw new Error("magic-link login_url missing — dev server (non-production) required for e2e");

  // Opening the link consumes the token, signs in, and redirects (→ onboarding).
  await page.goto(loginUrl);
  await page.waitForURL((u) => !u.pathname.startsWith("/magic-link"), { timeout: 30_000 });

  // The browser context is now authenticated — drive setup through it.
  await page.request.post("/api/onboarding/complete", { data: {} });
  await page.request.post("/api/tour", { data: {} }).catch(() => undefined);

  // Pro plan → advanced entitlements resolve like a paying org.
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required to set the org's plan to pro for e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    // The app lives in a dedicated schema — unqualified table names resolve
    // only when the search_path points there.
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
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

  // Session is already live from the magic link — confirm the app renders for
  // the (now Pro) org, then persist the browser storage state.
  await page.goto("/dashboard");
  await expect(page.getByRole("navigation")).toBeVisible();

  await page.context().storageState({ path: AUTH_STATE });
});
