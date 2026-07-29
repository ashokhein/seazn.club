import { defineConfig, devices } from "@playwright/test";

// E2E UI suite. Drives the real app in Chromium. Auth is provisioned once
// (auth.setup.ts → storageState) and reused across specs.
//
// Server:  a PRE-COMPILED production server, never `next dev` — dev's
//          per-request Turbopack compiles + half-RAM heap watchdog make a full
//          run flaky (transient 404s, restarts). Starting it is an explicit
//          PRECONDITION, not something this config does for you (#342, and the
//          `webServer` note at the bottom of this file): a server must already
//          be up on PLAYWRIGHT_BASE (:3000) against a migrated DB, and
//          e2e/global-setup.ts aborts the run with the recipe if it is missing
//          or broken. Because a prod build never dev-exposes `login_url`, local
//          runs need E2E_PROD_TARGET=1 + DATABASE_URL so the auth helpers mint
//          tokens in the DB (same as CI). Recipe: docs/runbooks/e2e-local.md.
//          CI: e2e.yml builds + starts against Postgres.
//
// Two projects, two phases (see the test:e2e script):
//   parallel — specs that only touch state they create (own competitions/
//              divisions); safe at several workers, tests within a file too.
//   serial   — specs entangled with shared org-level state: owned-org quota
//              (billing, billing-states, org-management all mint orgs on the
//              shared Pro user — cap + reasoning in e2e/auth.setup.ts,
//              "ORG BUDGET"), the community org's competitions.max_active
//              slots (journey-community, device-links), org renames, plan
//              flips, and the single Pro scorer seat. One worker, one file at
//              a time — `npm run test:e2e` runs this phase with --workers=1.
const BASE = process.env.PLAYWRIGHT_BASE ?? "http://localhost:3000";
const AUTH_STATE = "e2e/.auth/pro.json";

const SERIAL_SPECS =
  /(journey-pro|journey-community|org-management|billing|billing-states|billing-groups|billing-groups-journey|members-roles|scorer|device-links|division-delete|pricing-v3|player-accounts)\.spec\.ts/;

export default defineConfig({
  testDir: "./e2e",
  // Runs before EVERY project, `setup` included: proves the server on BASE is a
  // working build of this app, or aborts the whole run with the fix (#342).
  globalSetup: "./e2e/global-setup.ts",
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
  // NO `webServer` BLOCK, deliberately (#342). It used to run
  // `npm run build && npm run start`, which was wrong in three ways at once:
  //
  //   1. `next start` does not serve an `output: standalone` build. It prints
  //      `⚠ "next start" does not work with "output: standalone" configuration`
  //      and serves the non-standalone tree — i.e. not what production runs.
  //   2. It could only ever fire when nothing was listening, at which point it
  //      spent 5+ minutes building INSIDE a test run, mutating .next and
  //      leaving a stale .next/lock behind when the run was killed.
  //   3. It made the environment implicit. A run that quietly arranged its own
  //      broken server is exactly how this suite reported a green that meant
  //      nothing.
  //
  // The server is now a precondition you start yourself (docs/runbooks/e2e-local.md),
  // and e2e/global-setup.ts turns a missing or broken one into an immediate,
  // explicit abort instead of a build. Nothing in CI changes: e2e.yml starts its
  // own server, so `reuseExistingServer` meant this block never ran there — and
  // e2e.yml already sets SCHEDULING_AI_BASE_URL / ANTHROPIC_API_KEY (the v4 AI
  // fixture vars this block used to inject) job-wide. A locally started server
  // needs them too; the runbook lists them.
});
