import { defineConfig, devices } from "@playwright/test";

// E2E UI smoke suite. Drives the real app in Chromium. Auth is provisioned
// once (auth.setup.ts → storageState) and reused across specs.
//
// Local:  a dev server on PLAYWRIGHT_BASE (default :3000) must already be up
//         against a migrated DB (the webServer block boots one in CI).
// CI:     webServer starts `npm run dev` against the Postgres service.
const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";
const AUTH_STATE = "e2e/.auth/pro.json";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false, // shared account + shared DB — keep specs serial
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE },
      dependencies: ["setup"],
    },
  ],
  // A dev server is expected on BASE (the CI smoke job starts one; locally you
  // run your own). Reuse it if present, else boot one — never double-start.
  webServer: {
    command: "npm run dev",
    url: `${BASE}/api/health`,
    timeout: 120_000,
    reuseExistingServer: true,
  },
});
