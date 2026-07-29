# Running the Playwright e2e suite locally

The suite drives a **pre-compiled production server that you start yourself**.
`playwright.config.ts` has no `webServer` block on purpose (#342) — a config that
built and served the app for you is what produced runs that reported green while
testing a broken server. Instead, `e2e/global-setup.ts` inspects whatever is on
`PLAYWRIGHT_BASE` before a single spec runs and aborts with the fix if it is not
a healthy build of this app.

---

## 1. A database

Any migrated Postgres will do; it will accumulate `TAG`-prefixed e2e users and
orgs, so use a disposable one, never your dev DB if you care about its contents.

```bash
npm run db:apply        # Flyway migrate
npm run sync:sports     # sport catalog from the engine registry
```

## 2. Build

```bash
rm -rf apps/web/.next                      # see "Stale .next" below
npm run build --workspace apps/web
```

## 3. Stage the static tree into the standalone output

`next.config.js` sets `output: "standalone"`. The standalone output copies
`public/` for you, but **not** `.next/static` — a server booted without it
answers `/api/health` and page HTML with 200 while every `/_next/static/*.js`
chunk 404s. The app renders and then does nothing, and specs fail one by one on
clicks and navigations as if the product were broken.

```bash
rm -rf apps/web/.next/standalone/apps/web/.next/static
cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
```

The `rm -rf` first is not optional: BSD `cp -R src dst` when `dst` already
exists copies *into* it, so a second run silently produces
`.next/static/static/…`.

Note the path: `outputFileTracingRoot` points at the monorepo root, so the
server lands at `.next/standalone/**apps/web/**/server.js`, not the
`.next/standalone/server.js` that Next's own warning text names.

## 4. Start the server

**`npm run start` (`next start`) is wrong here.** It does not serve a standalone
build — it prints

```
⚠ "next start" does not work with "output: standalone" configuration. Use "node .next/standalone/server.js" instead.
```

and serves the non-standalone tree, i.e. not what production runs.

```bash
cd apps/web
DATABASE_URL="postgresql://postgres@127.0.0.1:5432/your_e2e_db" \
DATABASE_SSL=disable \
AUTH_SECRET=e2e-local-secret \
E2E_PROD_TARGET=1 \
NODE_ENV=production \
PORT=3100 \
NEXT_PUBLIC_SUPABASE_URL="https://stub.supabase.co" \
SCHEDULING_AI_BASE_URL=http://127.0.0.1:4319 \
ANTHROPIC_API_KEY=sk-ant-e2e-fixture \
STRIPE_SECRET_KEY=sk_test_ci_e2e_dummy \
STRIPE_WEBHOOK_SECRET=whsec_e2e_payments \
  node .next/standalone/apps/web/server.js
```

### The env vars, and why

| Var | Why |
| --- | --- |
| `DATABASE_URL` | Same DB the runner's SQL helpers use. If the server and the runner point at different databases, logins mint on one and are consumed on the other. |
| `AUTH_SECRET` | **Required.** Under `NODE_ENV=production` a server without it cannot sign a session: consuming a real login token returns `{"ok":false,"error":"AUTH_SECRET environment variable is required in production"}` and every login in the suite fails. |
| `E2E_PROD_TARGET=1` | A production build never dev-exposes `login_url`, so the auth helpers mint login tokens straight in the DB. Set it for the runner too. |
| `REDIS_URL` | **Must be UNSET.** With Redis reachable the magic-link limiter (5 per 5 min, fail-closed) stops being inert and throttles the suite's own logins. CI omits Redis deliberately. |
| `NEXT_PUBLIC_SUPABASE_URL` | A stub, not empty: `publicStorageUrl("")` hides every badge/crest and makes logo assertions untestable. |
| `SCHEDULING_AI_BASE_URL`, `ANTHROPIC_API_KEY` | `ai-architect.spec.ts` starts a model fixture server on `AI_FIXTURE_PORT` (4319); the app must point at it and carry a non-empty key so the ai-plan routes never 503. These used to be injected by the old `webServer.env` block, which only ever applied to a server Playwright started itself. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Only for `payments-hardening.spec.ts`, which posts signed synthetic webhooks at the real route. CI dummies; no real Stripe call is made. |

`NEXT_PUBLIC_*` values are baked at **build** time — set them for step 2 as well
as step 4.

## 5. Run the suite

```bash
cd apps/web
DATABASE_URL="…" DATABASE_SSL=disable E2E_PROD_TARGET=1 \
PLAYWRIGHT_BASE=http://localhost:3100 \
  npm run test:e2e            # parallel, then serial --workers=1, then both mobile projects
```

Single spec / project:

```bash
PLAYWRIGHT_BASE=http://localhost:3100 npx playwright test --project=parallel marketing-home.spec.ts
PLAYWRIGHT_BASE=http://localhost:3100 npx playwright test --project=mobile-se
```

`PLAYWRIGHT_BASE` defaults to `http://localhost:3000`, so it is required
whenever your server is on another port.

---

## What the preflight rejects

`e2e/global-setup.ts` runs once, before every project (including `setup`, which
is what spends the login budget). Each check aborts the run with the resolved
base URL and the recipe:

| Symptom | Meaning |
| --- | --- |
| `REDIS_URL is set in this shell` | `unset REDIS_URL`. |
| `no server answering at …/api/health` | Nothing listening, or wrong `PLAYWRIGHT_BASE`. |
| `not healthy — /api/health returned 503 {"ok":false,"db":"down"}` | Server is up but cannot reach `DATABASE_URL`. |
| `renders HTML but does not serve its own JavaScript` | Step 3 was skipped, or you served with `next start`. |
| `/api/auth/magic-link/consume answered 404` | The build being served is not this app (stale or partial). |
| `the server … has no AUTH_SECRET` | Step 4's `AUTH_SECRET`. |

## Failure modes worth knowing

**Stale `.next`.** A killed build leaves `.next/lock` behind and the next build
can wedge on it. `rm -rf apps/web/.next` before rebuilding. Note this also wipes
`.next/standalone`, so step 3 must be redone every time.

**Killing the server.** Next renames its process, so `pkill -f "server.js"`
does **not** match it. Kill by port:

```bash
kill $(lsof -t -nP -iTCP:3100 -sTCP:LISTEN)
```

**Wrapper summaries lie.** A run that aborts in global setup exits 1 having
collected zero tests, which some tool summaries render as `PASS (0) FAIL (0)` —
indistinguishable from a clean skip. Read Playwright's own last line
(`11 passed (15.1s)`) and the exit code, not a wrapper's tally.

**Fresh worktree.** `next build` fails with
`Symlink [project]/node_modules is invalid, it points out of the filesystem root`
if the worktree's root `node_modules` is a symlink to the main checkout. Replace
it with a real directory (`cp -Rc` clones it near-instantly on APFS, or run
`npm ci`).

**A run leaves data behind** in whichever DB it targeted — `TAG`-prefixed users,
orgs and competitions. Expected; use a disposable database.

## CI

`.github/workflows/e2e.yml` starts its own server against its own Postgres
service, with no Redis and job-wide env, then runs `npm run test:e2e` — so the
removal of the `webServer` block changes nothing there (`reuseExistingServer`
meant it never fired in CI), and the preflight passes against it.

One difference remains: CI still starts the server with `npm run start`
(`next start`), which is the mismatch described in step 4. It survives because
`next start` does serve `.next/static` (the chunks it can't find are only a
problem in the *standalone* tree), so the preflight's asset probe passes — but
CI is not exercising the server production runs. Left alone here deliberately:
this workflow is manual-only (Actions → E2E → Run workflow) and is not to be
enabled or edited as part of this change.
