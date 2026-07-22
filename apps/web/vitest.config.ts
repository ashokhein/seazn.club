import { defineConfig } from "vitest/config";
import fs from "fs";
import path from "path";

// vitest loads no env file of its own. Every DB-backed suite guards on
// `const HAS_DB = !!process.env.DATABASE_URL` + `describe.skipIf(!HAS_DB)`, so
// without it exported in the shell ~700 tests silently skipped and the run
// still printed green — the suite read as coverage it was not providing.
// Load the canonical repo-root .env.local (apps/web/.env.local symlinks to it)
// so a bare `npx vitest run` exercises them.
//
// A missing file is not fatal: CI ships no .env.local and supplies DATABASE_URL
// / REDIS_URL through the job environment instead. Node's loader never
// overwrites an already-set variable, so an exported value (or CI's) still wins.
const rootEnvFile = path.resolve(__dirname, "../../.env.local");
const preexisting = new Set(Object.keys(process.env));
if (fs.existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);
/** Keys this config introduced — an exported value was never overwritten. */
const fileOnly = (k: string) => !preexisting.has(k) && k in process.env;

// …but the file is a DEVELOPER's env, so it also carries live third-party
// credentials, and a unit test that quietly calls a real vendor is worse than
// one that skips. Drop the outbound ones the suite has always run without:
//
//   POSTHOG*  — posthog-server.ts reads the key at module load with
//               flushAt:1/flushInterval:0, so every captureServer() awaits a
//               real HTTPS round-trip. With the key present, org-posts'
//               22- and 25-post pagination tests blew the 5s timeout, and the
//               run was shipping fake events into the live project.
//               posthog-server.test.ts already documents "unconfigured" as the
//               contract for CI and local test.
//   RESEND_API_KEY   — lib/email.ts:110 send() only no-ops WITHOUT a key; the
//               suites that don't mock @/lib/email say so explicitly ("no-op
//               without RESEND_API_KEY either way"). With one, they mail out.
//   ANTHROPIC_API_KEY — every AI test sets its own dummy key; a real one just
//               means a slipped path bills us. The one live bench
//               (schedule-ai-effort-ab.live.test.ts, AI_AB_LIVE=1) reads
//               .env.local itself, so it is unaffected.
//
//   STRIPE_SECRET_KEY — "the rest mock the Stripe module" is not true. Five
//               suites reference Stripe unmocked, and two use KEYLESSNESS ITSELF
//               as the mechanism under test:
//                 sponsor-dispute.test.ts        — "the keyless test env makes
//                   getStripe() throw, so recovery takes its audited failure path"
//                 sponsor-order-delete-guards.test.ts — "a clean 409 also proves
//                   the guard fired before any Stripe call"
//               With a key present, dispute-recovery.ts:63-64 constructs a client
//               and awaits stripe.charges.retrieve() on a fabricated id — a real
//               HTTPS call per run. It throws, the catch at :100 writes the same
//               `dispute_recovery_failed` audit the test asserts, and the suite
//               stays green for entirely the wrong reason. The delete-guard test
//               is worse: if that guard ever regressed it would now attempt a
//               REAL refund instead of throwing a config error.
//               Kept only under BILLING_LIVE=1, because billing-proration.live
//               documents an invocation that sources the key from this file.
const wantsLiveBilling = process.env.BILLING_LIVE === "1";

// Anything exported by hand survives this — it's only the file's values we drop.
for (const key of [
  "POSTHOG_KEY",
  "POSTHOG_HOST",
  "NEXT_PUBLIC_POSTHOG_KEY",
  "NEXT_PUBLIC_POSTHOG_HOST",
  "RESEND_API_KEY",
  "ANTHROPIC_API_KEY",
  ...(wantsLiveBilling ? [] : ["STRIPE_SECRET_KEY"]),
]) {
  if (fileOnly(key)) delete process.env[key];
}

export default defineConfig({
  test: {
    environment: "node",
    pool: "threads",
    // Each DB suite lazily creates a postgres client (cached on globalThis) and
    // ends it in afterAll. With isolate:false that client + globalThis are shared
    // across files, so one file's teardown strands another file's in-flight query
    // (CONNECTION_ENDED). Isolate per file so each owns — and ends — its own
    // connection; the teardown races vanish.
    isolate: true,
    // Playwright specs (e2e/) run under `playwright test`, not vitest. The
    // .next exclude matters: `next build` copies the whole tree (e2e specs
    // included) into .next/standalone, and vitest globbing those copies after
    // a local build segfaulted the run.
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**", "**/.next/**"],
    // @seazn/engine ships TS source (workspace symlink) — inline it so vitest
    // transforms it instead of treating it as an opaque external dep.
    server: { deps: { inline: [/@seazn\/engine/] } },
    coverage: {
      provider: "v8",
      // The v1 engine (pairing/standings/engine) was deleted at the PROMPT-15
      // cutover; engine math coverage lives in packages/engine. What remains
      // here is the pure migration mapping.
      include: ["src/server/migration/v1-map.ts"],
      thresholds: { lines: 95, functions: 95, branches: 90 },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // `server-only` is a Next build-time marker, absent under vitest.
      "server-only": path.resolve(__dirname, "vitest.stubs/server-only.ts"),
    },
  },
});
