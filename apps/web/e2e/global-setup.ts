import type { FullConfig } from "@playwright/test";

/**
 * Preflight: refuse to run a single spec against a server that is not a
 * working build of this app (#342).
 *
 * The failure this exists for is a run that LOOKS fine. Every probe below was
 * reproduced locally against a real build of this repo:
 *
 *  - A standalone build served without its static tree staged answers
 *    `/api/health` 200 and `/pricing` 200 while every `/_next/static/*.js`
 *    chunk 404s. Nothing hydrates, so specs fail one at a time on clicks and
 *    navigations that look like product bugs.
 *  - A server booted without AUTH_SECRET under NODE_ENV=production answers
 *    `{"ok":false,"error":"AUTH_SECRET environment variable is required in
 *    production"}` the moment a real login token is consumed — i.e. auth is
 *    dead, but only the auth *setup* discovers it.
 *  - With REDIS_URL exported the magic-link limiter (5 per 5 min, fail-closed)
 *    stops being inert and throttles the suite's own logins.
 *
 * This is the right hook for these checks: it runs once, in the runner process,
 * before EVERY project — including `setup`, which is what mints accounts and
 * spends the login budget. `webServer.url` cannot do this job: it is a liveness
 * poll that only reads a status code, and with `reuseExistingServer` it is
 * skipped the moment anything is listening. Nothing here writes to the database
 * or logs anybody in; provisioning stays entirely in auth.setup.ts.
 *
 * Every abort prints the resolved base URL and points at docs/runbooks/e2e-local.md.
 */

const PROBE_TIMEOUT_MS = 10_000;

const RECIPE = [
  "  npm run build --workspace apps/web",
  "  rm -rf apps/web/.next/standalone/apps/web/.next/static",
  "  cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static",
  "  AUTH_SECRET=… DATABASE_URL=… E2E_PROD_TARGET=1 \\",
  "    node apps/web/.next/standalone/apps/web/server.js",
  "",
  "Full recipe (env vars, ports, cleanup): docs/runbooks/e2e-local.md",
].join("\n");

/** fetch that never hangs the whole run, and never throws. */
async function probe(url: string, init?: RequestInit): Promise<Response | null> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }).catch(() => null);
}

function fail(message: string): never {
  // Playwright prints the message and aborts before any project runs.
  throw new Error(`\n[e2e preflight] ${message}\n`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const base = (
    config.projects[0]?.use?.baseURL ??
    process.env.PLAYWRIGHT_BASE ??
    "http://localhost:3000"
  ).replace(/\/$/, "");

  // 1. Redis. Checked first because it needs no network and is pure operator
  //    error: with a reachable Redis the fail-closed magic-link limiter is live
  //    and the suite throttles its own logins (CI omits Redis on purpose).
  if (process.env.REDIS_URL) {
    fail(
      "REDIS_URL is set in this shell.\n" +
        "The magic-link limiter (5 per 5 min, fail-closed) is then live and throttles the\n" +
        "suite's own logins — CI omits Redis deliberately. Unset it for e2e runs:\n" +
        "  unset REDIS_URL",
    );
  }

  // 2. Is anything healthy there at all? /api/health also proves the server
  //    reached its database, so a wrong/missing DATABASE_URL fails here rather
  //    than as a wall of spec failures.
  const health = await probe(`${base}/api/health`);
  if (!health) {
    fail(`no server answering at ${base}/api/health.\nStart one:\n${RECIPE}`);
  }
  const healthBody = await health.text().catch(() => "");
  if (!health.ok || !healthBody.includes('"ok":true')) {
    fail(
      `the server at ${base} is not healthy — /api/health returned ${health.status} ${healthBody}\n` +
        `A 503 with "db":"down" means the server cannot reach DATABASE_URL.\n${RECIPE}`,
    );
  }

  // 3. Is it serving its own JavaScript? This is the #342 trap: a standalone
  //    build whose .next/static was never staged serves HTML 200 and chunks
  //    404, so the app renders and then does nothing.
  const page = await probe(`${base}/`);
  const html = page ? await page.text().catch(() => "") : "";
  const chunk = /\/_next\/static\/[^"']+?\.js/.exec(html)?.[0];
  if (!chunk) {
    // Not fatal: a redesigned shell could legitimately inline everything. Say
    // so rather than silently skipping the check.
    console.warn(
      `[e2e preflight] no /_next/static chunk referenced by ${base}/ — skipping the static-asset check`,
    );
  } else {
    const asset = await probe(`${base}${chunk}`);
    if (!asset?.ok) {
      fail(
        `${base} renders HTML but does not serve its own JavaScript ` +
          `(${chunk} → ${asset ? asset.status : "no response"}).\n` +
          "Nothing on the page will hydrate, so specs would fail on clicks and navigations\n" +
          "as if the product were broken. Cause, almost always: an `output: standalone`\n" +
          "build served without .next/static staged into the standalone tree — or served\n" +
          "with `next start`, which does not serve a standalone build at all.\n" +
          RECIPE,
      );
    }
  }

  // 4. Is the auth route the served build actually has, alive and talking to a
  //    database? A bogus token is rejected in the same transaction a real one
  //    is consumed, so a 404/405 here means the build being served is not this
  //    app. The AUTH_SECRET complaint can only surface on a VALID token (the
  //    key is touched only when a session is signed), so this is a cheap
  //    belt-and-braces check, not the primary catch — auth.setup.ts, which runs
  //    next, is what proves signing works end to end.
  const consume = await probe(`${base}/api/auth/magic-link/consume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "e2e-preflight-probe-token" }),
  });
  const consumeBody = consume ? await consume.text().catch(() => "") : "";
  if (!consume || consume.status === 404 || consume.status === 405) {
    fail(
      `${base}/api/auth/magic-link/consume answered ${consume ? consume.status : "nothing"} to a POST.\n` +
        "The server under test is not serving this app's routes (stale or partial build).\n" +
        RECIPE,
    );
  }
  if (/AUTH_SECRET environment variable is required/.test(consumeBody)) {
    fail(
      `the server at ${base} has no AUTH_SECRET — it cannot sign a session, so every login\n` +
        "in the suite will fail. Export AUTH_SECRET in the shell that starts the server.",
    );
  }
}
