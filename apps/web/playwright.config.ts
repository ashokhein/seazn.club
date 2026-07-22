import { defineConfig, devices } from "@playwright/test";

// E2E UI suite. Drives the real app in Chromium. Auth is provisioned once
// (auth.setup.ts → storageState) and reused across specs.
//
// Server:  a PRE-COMPILED production server (`next build` + `next start`), never
//          `next dev` — dev's per-request Turbopack compiles + half-RAM heap
//          watchdog make a full run flaky (transient 404s, restarts). Local: a
//          server on PLAYWRIGHT_BASE (:3000) must already be up against a
//          migrated DB, else the webServer block builds + starts one. Because a
//          prod build never dev-exposes `login_url`, local runs need
//          E2E_PROD_TARGET=1 + DATABASE_URL so the auth helpers mint tokens in
//          the DB (same as CI). CI: e2e.yml builds + starts against Postgres.
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
  // A server is expected on BASE (CI starts one; locally you usually run your
  // own). Reuse it if present, else build + start a production server — never
  // `next dev`, never double-start. The long timeout covers a cold build.
  webServer: {
    command: "npm run build && npm run start",
    url: `${BASE}/api/health`,
    timeout: 300_000,
    reuseExistingServer: true,
    // v4 Task 17: point the AI Schedule Architect at the e2e model fixture
    // server (ai-fixture-server.ts, started by the spec on AI_FIXTURE_PORT) and
    // give the client a key so the resolved AI provider never 503s. Only affects a
    // server Playwright itself starts; a reused server must be booted with these
    // vars (the spec's local-run recipe does so). Harmless to every other spec.
    env: {
      SCHEDULING_AI_BASE_URL:
        process.env.SCHEDULING_AI_BASE_URL ??
        `http://127.0.0.1:${process.env.AI_FIXTURE_PORT ?? "4319"}`,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "sk-ant-e2e-fixture",
    },
  },
});
