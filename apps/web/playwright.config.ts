import { defineConfig, devices } from "@playwright/test";

// E2E UI suite. Drives the real app in Chromium. Auth is provisioned once
// (auth.setup.ts → storageState) and reused across specs.
//
// Local:  a dev server on PLAYWRIGHT_BASE (default :3000) must already be up
//         against a migrated DB (the webServer block boots one otherwise).
// CI:     e2e.yml starts the server against the Postgres service.
//
// Two projects, two phases (see the test:e2e script):
//   parallel — specs that only touch state they create (own competitions/
//              divisions); safe at several workers, tests within a file too.
//   serial   — specs entangled with shared org-level state: owned-org quota
//              (billing, billing-states, org-management sit exactly at Pro's
//              cap of 5 with setup), the community org's competitions.max_active
//              slots (journey-community, device-links), org renames, plan
//              flips, and the single Pro scorer seat. One worker, one file at
//              a time — `npm run test:e2e` runs this phase with --workers=1.
const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";
const AUTH_STATE = "e2e/.auth/pro.json";

const SERIAL_SPECS =
  /(journey-pro|journey-community|org-management|billing|billing-states|members-roles|scorer|device-links|division-delete|pricing-v3|player-accounts)\.spec\.ts/;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true, // parallel project only — the serial phase runs with --workers=1
  workers: process.env.CI ? 2 : 4,
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
      name: "parallel",
      testIgnore: [SERIAL_SPECS, /mobile\.spec\.ts/],
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE },
      dependencies: ["setup"],
    },
    {
      name: "serial",
      testMatch: SERIAL_SPECS,
      fullyParallel: false,
      use: { ...devices["Desktop Chrome"], storageState: AUTH_STATE },
      dependencies: ["setup"],
    },
    // v3/02 §4 viewport gate: mobile.spec.ts runs at both reference phones —
    // iPhone SE (375×667) and iPhone 14 (390×844). Desktop projects ignore it.
    {
      name: "mobile-se",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 375, height: 667 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
    {
      name: "mobile-14",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
  ],
  // A dev server is expected on BASE (CI starts one; locally you usually run
  // your own). Reuse it if present, else boot one — never double-start.
  webServer: {
    command: "npm run dev",
    url: `${BASE}/api/health`,
    timeout: 120_000,
    reuseExistingServer: true,
  },
});
