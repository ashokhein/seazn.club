import { test, expect } from "@playwright/test";

// Exercises the login UI itself, so it runs in a fresh, unauthenticated context
// (override the shared Pro storage state).
test.use({ storageState: { cookies: [], origins: [] } });

const email = `e2e-magic-${Date.now().toString(36)}@example.com`;

test("passwordless login: emailing a link creates the account and signs in", async ({
  page,
}) => {
  await page.goto("/login");

  // No password field on the login form — the flow is email-only.
  await expect(page.getByLabel("Password")).toHaveCount(0);

  await page.getByLabel("Email").fill(email);
  await page
    .locator("form")
    .getByRole("button", { name: /email me a sign-in link/i })
    .click();

  // Confirmation card; dev exposes the link as a clickable "dev link".
  await expect(page.getByText(/check your email/i)).toBeVisible();
  const devLink = page.getByRole("link", { name: /sign in \(dev link\)/i });
  await expect(devLink).toBeVisible();

  // Opening the link consumes the token, signs the new user in, and redirects.
  await devLink.click();
  await page.waitForURL(
    (u) => !u.pathname.startsWith("/login") && !u.pathname.startsWith("/magic-link"),
    { timeout: 30_000 },
  );

  const cookies = await page.context().cookies();
  expect(cookies.some((c) => c.name === "seazn_session")).toBeTruthy();
});

// Invite pages (/join/{token}) send a `next` redirect with the email — both
// the send AND consume endpoints must accept it (each once rejected it with a
// strict schema) and the user must land on the invite page after sign-in.
test("magic-link threads the invite-page `next` redirect through sign-in", async ({
  request,
  page,
}) => {
  const res = await request.post("/api/auth/magic-link", {
    data: { email: `e2e-next-${Date.now().toString(36)}@example.com`, next: "/join/some-token" },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.data.login_url).toContain(`next=${encodeURIComponent("/join/some-token")}`);

  // Opening the emailed link consumes the token and lands on the invite page.
  await page.goto(body.data.login_url);
  await page.waitForURL((u) => u.pathname === "/join/some-token", { timeout: 30_000 });
});
