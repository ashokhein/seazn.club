# Approach A — Monolith Tuning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make page + backend performance materially better without new services: session-pooler-ready DB config, Redis slug cache, multi-machine-safe ISR revalidation, `next/image` on public surfaces, CSP that never kills caching, a trimmed scoring tail, and a CDN purge seam.

**Architecture:** Everything stays in the `apps/web` monolith. Each task is an independent, reversible slice with its own regression test. No schema migrations in this wave. The revalidation-broadcast + CDN-purge work concentrates at one seam (`server/public-site/revalidate.ts`) so a later Cloud Run move only swaps transports there.

**Tech Stack:** Next 16 App Router, postgres.js, ioredis/Upstash (fail-open via `lib/cache`), Fly.io machines, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-07-12-architecture-performance-design.md`

## Global Constraints

- Branch: `feat/perf-a-monolith-tuning`; PR to `main` at the end.
- **No DB schema changes** in this wave (no Flyway migration files).
- Every code change ships with a regression test that fails without it (repo rule).
- Before any push: `npm run typecheck --workspace apps/web && npm run test` (repo rule — unit tests alone have missed tsc breaks).
- Public ISR contract unchanged: `REVALIDATE_FAST = 30`, `REVALIDATE_SLOW = 300` (`server/public-site/data.ts`).
- Redis is always **fail-open** (matching `lib/cache.ts` philosophy): no Redis ⇒ behavior identical to today.
- This Next version has breaking changes vs training data — before touching any Next API, read the relevant guide under `node_modules/next/dist/docs/` (repo AGENTS.md rule).
- `npm run build --workspace apps/web` (standalone output) must stay green — Docker deploy depends on it.
- Vitest DB-backed suites use the ephemeral local Postgres on :54329 (see repo memory/README recipe); pure-unit tests must not require a DB.

---

### Task 1: Session-pooler-ready DB config (`connectionOptions`)

The app is an always-on Fly machine, not serverless. Moving `DATABASE_URL` from the transaction pooler (`:6543`) to the session pooler (`:5432`) re-enables prepared statements — `lib/db.ts` already derives `prepare` from the URL, but the option derivation is untestable (buried in `getClient`) and pool size is hard-coded at 5. Extract a pure function, make pool size env-tunable, document the URL swap.

**Files:**
- Modify: `apps/web/src/lib/db.ts`
- Test: `apps/web/src/lib/__tests__/db-options.test.ts` (new)
- Modify: `fly.toml` (secrets comment block only)

**Interfaces:**
- Produces: `connectionOptions(url: string, env?: Record<string, string | undefined>): { ssl: false | "require"; prepare: boolean; max: number; schema: string }` exported from `@/lib/db`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/db-options.test.ts
import { describe, expect, it } from "vitest";
import { connectionOptions } from "@/lib/db";

describe("connectionOptions", () => {
  const remote = "postgresql://u:p@aws-0-eu-west-2.pooler.supabase.com";

  it("disables prepared statements on the transaction pooler (:6543)", () => {
    expect(connectionOptions(`${remote}:6543/postgres`, {}).prepare).toBe(false);
  });

  it("enables prepared statements on the session pooler (:5432)", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, {}).prepare).toBe(true);
  });

  it("requires SSL for remote hosts, none for localhost", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, {}).ssl).toBe("require");
    expect(connectionOptions("postgresql://u:p@localhost:5432/seazn", {}).ssl).toBe(false);
  });

  it("honors DATABASE_SSL override", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, { DATABASE_SSL: "disable" }).ssl).toBe(false);
    expect(connectionOptions("postgresql://u:p@localhost:5432/x", { DATABASE_SSL: "require" }).ssl).toBe("require");
  });

  it("defaults pool max to 5, accepts DB_POOL_MAX within 1..50, rejects garbage", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, {}).max).toBe(5);
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_POOL_MAX: "10" }).max).toBe(10);
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_POOL_MAX: "0" }).max).toBe(5);
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_POOL_MAX: "banana" }).max).toBe(5);
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_POOL_MAX: "999" }).max).toBe(5);
  });

  it("defaults schema to seazn_club, honors DB_SCHEMA", () => {
    expect(connectionOptions(`${remote}:5432/postgres`, {}).schema).toBe("seazn_club");
    expect(connectionOptions(`${remote}:5432/postgres`, { DB_SCHEMA: "public" }).schema).toBe("public");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/db-options.test.ts`
Expected: FAIL — `connectionOptions` is not exported.

- [ ] **Step 3: Implement — extract the pure function in `lib/db.ts`**

Insert above `getClient` and rewire `getClient` to use it (delete the inline `isLocal`/`sslEnv`/`ssl`/`prepare`/`schema` lines):

```ts
export interface DbConnectionOptions {
  ssl: false | "require";
  prepare: boolean;
  max: number;
  schema: string;
}

/**
 * Pure derivation of postgres.js options from the URL + env. Session pooler
 * (:5432) / direct connections keep prepared statements; Supabase's
 * transaction pooler (:6543) does not support them. Pool size is env-tunable
 * (DB_POOL_MAX, 1..50) so a machine-size bump doesn't need a code change.
 */
export function connectionOptions(
  url: string,
  env: Record<string, string | undefined> = process.env,
): DbConnectionOptions {
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sslEnv = env.DATABASE_SSL;
  const ssl: false | "require" =
    sslEnv === "disable" ? false : sslEnv === "require" ? "require" : isLocal ? false : "require";
  const prepare = !url.includes(":6543");
  const rawMax = Number(env.DB_POOL_MAX);
  const max = Number.isInteger(rawMax) && rawMax >= 1 && rawMax <= 50 ? rawMax : 5;
  const schema = env.DB_SCHEMA ?? "seazn_club";
  return { ssl, prepare, max, schema };
}
```

In `getClient`, replace the derivation block with:

```ts
  const { ssl, prepare, max, schema } = connectionOptions(url);
```

and pass `max` instead of the literal `5` in the `postgres(url, { … })` call. Keep the `debug` counter, `types`, `idle_timeout`, `connect_timeout` untouched.

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/db-options.test.ts && npm run typecheck --workspace apps/web`
Expected: PASS. Also run the full unit suite once (`npm run test --workspace apps/web`) — the statement-count budget tests (`statementCount()`) must be unaffected.

- [ ] **Step 5: Document the pooler swap in `fly.toml`**

In the secrets comment block, change the `DATABASE_URL` line to:

```toml
# DATABASE_URL             — Supabase SESSION pooler URL (port 5432, Supavisor).
#                            The app is an always-on server: session mode keeps
#                            prepared statements (transaction pooler :6543
#                            disables them — lib/db.ts auto-detects either).
# DB_POOL_MAX              — optional, default 5; raise with machine size.
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/db.ts apps/web/src/lib/__tests__/db-options.test.ts fly.toml
git commit -m "perf: extract connectionOptions, env-tunable pool, session-pooler docs"
```

Ops note (post-merge, not in this repo): `fly secrets set DATABASE_URL=<session-pooler-url>` then verify `select count(*) from pg_prepared_statements` grows under load.

---

### Task 2: Redis read-through cache for slug resolution

`server/slug-resolve.ts` hits Postgres 2–4× on every authenticated navigation (org → comp → div chain) with only per-request `React.cache()` dedupe. Add a fail-open Redis layer: **positive live-row resolutions only** (renames/misses always go to the DB — they're rare and correctness-critical), 60s TTL, explicit invalidation at the three rename sites.

**Files:**
- Modify: `apps/web/src/server/slug-resolve.ts`
- Modify: `apps/web/src/server/usecases/competitions.ts` (~line 224 caller)
- Modify: `apps/web/src/server/usecases/divisions.ts` (~line 380 caller)
- Modify: `apps/web/src/app/api/orgs/[id]/route.ts` (~line 93 caller)
- Test: `apps/web/src/server/__tests__/slug-cache.test.ts` (new)

**Interfaces:**
- Consumes: `cacheGet`, `cacheSet`, `cacheDelPattern` from `@/lib/cache` (fail-open, no-ops without REDIS_URL).
- Produces: `invalidateSlugCache(kind: "org" | "competition" | "division", parentId: string | null, ...slugs: (string | null | undefined)[]): Promise<void>` exported from `@/server/slug-resolve`.

- [ ] **Step 1: Write the failing test (mocked cache backend)**

Follow the `lib/__tests__/entitlements-cache.test.ts` pattern — mock `@/lib/cache` with a Map-backed fake, mock `@/lib/db` for the resolver's SQL:

```ts
// apps/web/src/server/__tests__/slug-cache.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
vi.mock("@/lib/cache", () => ({
  cacheGet: vi.fn(async (k: string) => store.get(k) ?? null),
  cacheSet: vi.fn(async (k: string, v: unknown) => void store.set(k, v)),
  cacheDelPattern: vi.fn(async (p: string) => void store.delete(p)),
}));

// Each sql`` call resolves to the next queued result — enough to script
// live-hit vs miss sequences without a database.
const results: unknown[][] = [];
vi.mock("@/lib/db", () => ({
  sql: vi.fn(() => Promise.resolve(results.shift() ?? [])),
}));

import { orgBySlug, invalidateSlugCache } from "@/server/slug-resolve";
import { cacheSet, cacheDelPattern } from "@/lib/cache";
import { sql } from "@/lib/db";

beforeEach(() => {
  store.clear();
  results.length = 0;
  vi.clearAllMocks();
});

describe("slug resolution cache", () => {
  const live = { id: "org-1", name: "Riverside", slug: "riverside" };

  it("caches a live resolution and serves the repeat from Redis", async () => {
    results.push([live]); // first call: DB answers
    expect(await orgBySlug("riverside")).toEqual(live);
    expect(cacheSet).toHaveBeenCalledWith("slug:org:riverside", live, 60);

    // second call: no DB result queued — must come from cache
    expect(await orgBySlug("riverside")).toEqual(live);
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("never caches a miss or a rename fallback", async () => {
    results.push([], []); // live miss, history miss
    expect(await orgBySlug("ghost")).toBeNull();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it("invalidateSlugCache deletes old and new slug keys", async () => {
    await invalidateSlugCache("org", null, "riverside", "riverside-united");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:org:riverside");
    expect(cacheDelPattern).toHaveBeenCalledWith("slug:org:riverside-united");
  });
});
```

> `React.cache()` dedupes per request; in vitest each `orgBySlug` call shares one module instance, so the test calls the un-deduped inner path — if `cache()` memoization makes call 2 skip the mock entirely, export the inner uncached function for the test (name it `orgBySlugUncached`) and keep the public API wrapped.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- run src/server/__tests__/slug-cache.test.ts`
Expected: FAIL — `invalidateSlugCache` not exported; no `cacheSet` calls.

- [ ] **Step 3: Implement in `server/slug-resolve.ts`**

Add at the top (after existing imports):

```ts
import { cacheGet, cacheSet, cacheDelPattern } from "@/lib/cache";

// Read-through cache for LIVE slug rows only (v3 perf wave). Renames and
// misses always hit Postgres: they're rare, and the slug_history fallback is
// correctness-critical. TTL bounds staleness if an invalidation is missed;
// rename paths call invalidateSlugCache explicitly.
const SLUG_TTL_SECONDS = 60;
const slugKey = (
  kind: "org" | "competition" | "division",
  parentId: string | null,
  slug: string,
): string =>
  kind === "org" ? `slug:org:${slug}` : `slug:${kind === "competition" ? "comp" : "div"}:${parentId}:${slug}`;

/** Drop cached resolutions for the given slugs (old + new after a rename). */
export async function invalidateSlugCache(
  kind: "org" | "competition" | "division",
  parentId: string | null,
  ...slugs: (string | null | undefined)[]
): Promise<void> {
  await Promise.all(
    slugs.filter((s): s is string => Boolean(s)).map((s) => cacheDelPattern(slugKey(kind, parentId, s))),
  );
}
```

Rework each resolver so the live-row path is cache-aside. `orgBySlug` becomes:

```ts
export const orgBySlug = cache(async (slug: string): Promise<Resolution> => {
  const key = slugKey("org", null, slug);
  const hit = await cacheGet<ResolvedEntity>(key);
  if (hit) return hit;
  const [live] = await sql<ResolvedEntity[]>`
    select id, name, slug from organizations where slug = ${slug}`;
  if (live) {
    await cacheSet(key, live, SLUG_TTL_SECONDS);
    return live;
  }
  const [hist] = await sql<{ entity_id: string }[]>`
    select entity_id from slug_history
    where entity_type = 'org' and parent_id is null and old_slug = ${slug}`;
  if (!hist) return null;
  const [target] = await sql<{ slug: string }[]>`
    select slug from organizations where id = ${hist.entity_id}`;
  return target ? { renamedTo: target.slug } : null;
});
```

Apply the same shape to `compBySlug` (key `slugKey("competition", orgId, slug)`) and `divBySlug` (key `slugKey("division", competitionId, slug)`). `fixtureByNo` stays uncached (single indexed lookup, high write churn). If the React `cache()` wrapper defeats the test's second-call assertion, export the inner functions as `orgBySlugUncached` etc. and wrap: `export const orgBySlug = cache(orgBySlugUncached);`.

- [ ] **Step 4: Wire invalidation at the three rename sites**

Each call goes **after the transaction commits** (cache delete inside a tx could be undone by a rollback yet stay deleted — harmless — but a commit after a failed delete would leave stale cache; ordering after commit + TTL bounds both):

1. `apps/web/src/app/api/orgs/[id]/route.ts` — after the tx block, next to the existing `fireOrgRevalidate(org.slug)` (~line 103):

```ts
    if (previousSlug) await invalidateSlugCache("org", null, previousSlug, org.slug);
```

2. `apps/web/src/server/usecases/competitions.ts` — the usecase containing line 224 (`recordSlugHistory(tx, "competition", auth.orgId, before.slug, id)`): after its `withTenant`/tx completes and the new slug is known:

```ts
  await invalidateSlugCache("competition", auth.orgId, before.slug, updated.slug);
```

3. `apps/web/src/server/usecases/divisions.ts` — same pattern around line 380, parent is the competition id:

```ts
  await invalidateSlugCache("division", before.competition_id, before.slug, updated.slug);
```

Adjust local variable names to what those functions actually use (`before`/`updated` per surrounding code); import `invalidateSlugCache` from `@/server/slug-resolve`.

- [ ] **Step 5: Run tests + full suite**

Run: `npm run test --workspace apps/web -- run src/server/__tests__/slug-cache.test.ts`
Expected: PASS.
Run: `npm run test --workspace apps/web && npm run typecheck --workspace apps/web`
Expected: PASS — in particular the existing DB-backed `server/__tests__/slug-resolve.test.ts` must still pass unchanged (cache is inert without REDIS_URL).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/server/slug-resolve.ts apps/web/src/server/__tests__/slug-cache.test.ts \
  apps/web/src/server/usecases/competitions.ts apps/web/src/server/usecases/divisions.ts \
  "apps/web/src/app/api/orgs/[id]/route.ts"
git commit -m "perf: redis read-through cache for slug resolution with rename invalidation"
```

---

### Task 3: Multi-machine ISR revalidation broadcast + machine right-size

`revalidateTag` only invalidates the machine that handled the write. With `min_machines_running = 2` (this task) the other machine would serve stale ISR for up to 30s and the "instant refresh after a score" contract breaks. Fix: every `fire*Revalidate` also POSTs the tags to peer machines over Fly's private 6PN network; peers apply them locally. Fail-open — a missed broadcast is bounded by the 30s ISR window.

**Files:**
- Create: `apps/web/src/lib/peer-revalidate.ts`
- Create: `apps/web/src/app/api/internal/revalidate/route.ts`
- Modify: `apps/web/src/server/public-site/revalidate.ts`
- Test: `apps/web/src/lib/__tests__/peer-revalidate.test.ts` (new)
- Test: `apps/web/src/app/api/internal/revalidate/route.test.ts` (new — same convention as `app/api/auth/change-email/confirm/route.test.ts`)
- Modify: `fly.toml` (vm memory, min machines)

**Interfaces:**
- Produces: `broadcastRevalidate(tags: string[], mode: "swr" | "expire"): Promise<void>` from `@/lib/peer-revalidate` — resolves peer IPs via `global.${FLY_APP_NAME}.internal` AAAA lookup, skips `FLY_PRIVATE_IP` (self), POSTs `{ tags, mode }` with `x-cron-secret` header; no-op unless `PEER_REVALIDATE === "1"` and `FLY_APP_NAME` + `CRON_SECRET` set. Accepts an optional third arg `deps?: { resolveIps?: () => Promise<string[]>; fetchFn?: typeof fetch }` for tests.
- Produces: `POST /api/internal/revalidate` — body `{ tags: string[] (≤20), mode: "swr" | "expire" }`, guarded by constant-time `x-cron-secret` check; applies tags locally only (never re-broadcasts — loop prevention).
- Modifies: `fireDivisionRevalidate` / `fireOrgRevalidate` / `fireDiscoveryRevalidate` each gain a trailing `void broadcastRevalidate([...tags], mode)`.

- [ ] **Step 1: Write the failing unit test for the broadcaster**

```ts
// apps/web/src/lib/__tests__/peer-revalidate.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { broadcastRevalidate } from "@/lib/peer-revalidate";

afterEach(() => vi.unstubAllEnvs());

function arm() {
  vi.stubEnv("PEER_REVALIDATE", "1");
  vi.stubEnv("FLY_APP_NAME", "seazn-club-prod");
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("FLY_PRIVATE_IP", "fdaa::3");
}

describe("broadcastRevalidate", () => {
  it("no-ops when PEER_REVALIDATE is not enabled", async () => {
    const fetchFn = vi.fn();
    await broadcastRevalidate(["division:d1"], "swr", { fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs tags to every peer except itself, with the secret header", async () => {
    arm();
    const fetchFn = vi.fn(async () => new Response("{}"));
    await broadcastRevalidate(["division:d1", "competition:c1"], "swr", {
      resolveIps: async () => ["fdaa::3", "fdaa::4", "fdaa::5"],
      fetchFn,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe("http://[fdaa::4]:3000/api/internal/revalidate");
    expect(init.headers["x-cron-secret"]).toBe("s3cret");
    expect(JSON.parse(init.body)).toEqual({ tags: ["division:d1", "competition:c1"], mode: "swr" });
  });

  it("swallows resolver and fetch failures (fail-open)", async () => {
    arm();
    await expect(
      broadcastRevalidate(["division:d1"], "swr", {
        resolveIps: async () => {
          throw new Error("dns down");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/peer-revalidate.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/peer-revalidate.ts`**

```ts
import "server-only";

// Fan revalidateTag out to sibling Fly machines (spec 2026-07-12 §3 A-step 5).
// Fly's 6PN DNS: `global.<app>.internal` AAAA-resolves to every machine's
// private IPv6. Fail-open by design: a lost broadcast is bounded by the 30s
// public ISR window (REVALIDATE_FAST). This module is the transport seam —
// a Cloud Run move swaps DNS fan-out for Redis pub/sub here, nothing else.
export interface BroadcastDeps {
  resolveIps?: () => Promise<string[]>;
  fetchFn?: typeof fetch;
}

async function flyPeerIps(appName: string): Promise<string[]> {
  const { resolve6 } = await import("node:dns/promises");
  return resolve6(`global.${appName}.internal`);
}

export async function broadcastRevalidate(
  tags: string[],
  mode: "swr" | "expire",
  deps: BroadcastDeps = {},
): Promise<void> {
  const appName = process.env.FLY_APP_NAME;
  const secret = process.env.CRON_SECRET;
  if (process.env.PEER_REVALIDATE !== "1" || !appName || !secret || tags.length === 0) return;
  try {
    const ips = await (deps.resolveIps ?? (() => flyPeerIps(appName)))();
    const self = process.env.FLY_PRIVATE_IP;
    const fetchFn = deps.fetchFn ?? fetch;
    await Promise.allSettled(
      ips
        .filter((ip) => ip !== self)
        .map((ip) =>
          fetchFn(`http://[${ip}]:3000/api/internal/revalidate`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-cron-secret": secret },
            body: JSON.stringify({ tags, mode }),
            signal: AbortSignal.timeout(2000),
          }),
        ),
    );
  } catch {
    // fail open — peers converge within REVALIDATE_FAST
  }
}
```

- [ ] **Step 4: Run unit test to verify it passes**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/peer-revalidate.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

```ts
// apps/web/src/app/api/internal/revalidate/route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

afterEach(() => vi.unstubAllEnvs());

const req = (body: unknown, secret?: string) =>
  new NextRequest("http://localhost:3000/api/internal/revalidate", {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-cron-secret": secret } : {}) },
    body: JSON.stringify(body),
  });

describe("POST /api/internal/revalidate", () => {
  it("401s without the shared secret (and when none is configured)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(req({ tags: ["t"], mode: "swr" }))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(req({ tags: ["t"], mode: "swr" }, "wrong"))).status).toBe(401);
  });

  it("400s on malformed bodies", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await POST(req({ tags: "not-an-array", mode: "swr" }, "s3cret"))).status).toBe(400);
    expect((await POST(req({ tags: ["t"], mode: "purge-everything" }, "s3cret"))).status).toBe(400);
    expect((await POST(req({ tags: Array(21).fill("t"), mode: "swr" }, "s3cret"))).status).toBe(400);
  });

  it("applies each tag locally and reports ok", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await POST(req({ tags: ["division:d1", "discovery"], mode: "swr" }, "s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: 2 });
  });
});
```

- [ ] **Step 6: Run route test to verify it fails**

Run: `npm run test --workspace apps/web -- run "src/app/api/internal/revalidate/route.test.ts"`
Expected: FAIL — route module missing.

- [ ] **Step 7: Implement the route**

```ts
// apps/web/src/app/api/internal/revalidate/route.ts
import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";

// Peer endpoint for multi-machine ISR coherence (lib/peer-revalidate). Applies
// tags LOCALLY only — it never re-broadcasts, so fan-out cannot loop. Guarded
// by the same CRON_SECRET the GHA cron endpoints use.
const Body = z.object({
  tags: z.array(z.string().min(1).max(200)).min(1).max(20),
  mode: z.enum(["swr", "expire"]),
});

function secretOk(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!secretOk(req.headers.get("x-cron-secret"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });
  const { tags, mode } = parsed.data;
  for (const tag of tags) {
    // Same Next 16 semantics as server/public-site/revalidate.ts: 'max' =
    // stale-while-revalidate for scoring pages; expire:0 = read-your-writes
    // for org chrome edits.
    if (mode === "expire") revalidateTag(tag, { expire: 0 });
    else revalidateTag(tag, "max");
  }
  return NextResponse.json({ ok: true, applied: tags.length });
}
```

> Verify the `revalidateTag` second-argument forms against `node_modules/next/dist/docs` before relying on them — `server/public-site/revalidate.ts:16` documents the `'max'` form this Next version uses. If `revalidateTag` throws when the route is invoked in vitest (outside a full request scope), wrap the loop body in the same try/catch used by `fire*Revalidate`.

- [ ] **Step 8: Wire broadcasts into `server/public-site/revalidate.ts`**

Add import and one line per fire-function (after the local `revalidateTag` calls, outside the try/catch so a local failure still broadcasts is NOT wanted — keep it **inside** the function but after the try/catch block, unconditional):

```ts
import { broadcastRevalidate } from "@/lib/peer-revalidate";
```

```ts
export function fireDivisionRevalidate(divisionId: string, competitionId?: string): void {
  const tags = [divisionTag(divisionId), ...(competitionId ? [competitionTag(competitionId)] : [])];
  try {
    revalidateTag(tags[0], "max");
    if (competitionId) revalidateTag(competitionTag(competitionId), "max");
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
  void broadcastRevalidate(tags, "swr");
}
```

`fireOrgRevalidate`: `void broadcastRevalidate([orgTag(orgSlug)], "expire");`
`fireDiscoveryRevalidate`: `void broadcastRevalidate([DISCOVERY_TAG], "swr");`

- [ ] **Step 9: fly.toml sizing**

```toml
[http_service]
  min_machines_running = 2          # deploy overlap + matchday headroom; peers
                                    # stay ISR-coherent via /api/internal/revalidate

[[vm]]
  size   = "shared-cpu-1x"
  memory = "1gb"
```

Also append to the secrets comment block: `# PEER_REVALIDATE=1 — enable multi-machine tag fan-out (requires CRON_SECRET)`.

- [ ] **Step 10: Full verification + commit**

Run: `npm run test --workspace apps/web && npm run typecheck --workspace apps/web`
Expected: PASS (route + broadcaster tests green, nothing else regressed).

```bash
git add apps/web/src/lib/peer-revalidate.ts apps/web/src/lib/__tests__/peer-revalidate.test.ts \
  apps/web/src/app/api/internal/revalidate apps/web/src/server/public-site/revalidate.ts fly.toml
git commit -m "perf: peer ISR revalidation broadcast; 2 machines / 1gb"
```

---

### Task 4: `next/image` for public-surface logos and badges

Zero `next/image` today — Supabase Storage originals ship raw to mobile spectators. Convert the **public-site** storage-served images (org logos, team badges) to `next/image`; leave arbitrary-URL avatars (OAuth etc.) as `<img>` since `remotePatterns` can't safely enumerate the whole https universe.

**Files:**
- Modify: `apps/web/next.config.mjs`
- Modify: `apps/web/package.json` (add `sharp`)
- Modify: the storage-image call sites under `apps/web/src/components/public-site/` and `apps/web/src/app/(public)/` — enumerate with `grep -rn "<img" apps/web/src/components/public-site "apps/web/src/app/(public)"` and convert those whose `src` comes from `resolveLogoUrl(...)` or `/storage/v1/object/public/`
- Test: `apps/web/src/lib/__tests__/image-config.test.ts` (new)

**Interfaces:**
- Consumes: `resolveLogoUrl` from `@/server/public-site/data` (unchanged).
- Produces: `images.remotePatterns` in next.config covering the Supabase storage host; converted components render `<Image>` with explicit `width`/`height` (or `fill` + `sizes`).

- [ ] **Step 1: Write the failing config test**

```ts
// apps/web/src/lib/__tests__/image-config.test.ts
import { describe, expect, it } from "vitest";
import config from "../../../next.config.mjs";

describe("next/image remotePatterns", () => {
  it("allows the Supabase storage public-object path and nothing broader", () => {
    const patterns = (config as { images?: { remotePatterns?: unknown[] } }).images?.remotePatterns ?? [];
    expect(patterns).toContainEqual(
      expect.objectContaining({
        protocol: "https",
        hostname: expect.stringContaining("supabase.co"),
        pathname: "/storage/v1/object/public/**",
      }),
    );
  });
});
```

> `next.config.mjs` is wrapped by `withSentryConfig` — if the wrapper hides `images`, assert on the pre-wrap object: export the inner `nextConfig` as a named export (`export { nextConfig };`) and import that in the test instead.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/image-config.test.ts`
Expected: FAIL — no `images` key.

- [ ] **Step 3: Config + dependency**

```bash
npm install sharp --workspace apps/web
```

In `next.config.mjs`, inside `nextConfig`:

```js
  // next/image: only Supabase Storage public objects are optimizable —
  // arbitrary avatar URLs stay on plain <img> (can't enumerate the internet
  // in remotePatterns). Long minimumCacheTTL: logos change rarely and the
  // optimizer output is CPU we don't want to respend (spec 2026-07-12 P2).
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: process.env.NEXT_PUBLIC_SUPABASE_URL
          ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname
          : "*.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
    minimumCacheTTL: 86400,
  },
```

- [ ] **Step 4: Convert the public-site call sites**

Enumerate: `grep -rn "<img" apps/web/src/components/public-site "apps/web/src/app/(public)"`. For each hit whose `src` is a storage/logo URL (from `resolveLogoUrl`, `entrantLogos`, `org.logo`), convert following this pattern:

```tsx
import Image from "next/image";

// before
<img src={logo} alt={`${org.name} logo`} className="h-10 w-10 rounded object-cover" />

// after — explicit dimensions match the rendered box; next/image serves
// resized webp/avif and lazy-loads below the fold by default
<Image src={logo} alt={`${org.name} logo`} width={40} height={40} className="h-10 w-10 rounded object-cover" />
```

Rules: dimensions = the Tailwind box the class already imposes (h-10 w-10 → 40×40); hero/full-width images use `fill` + `sizes="(max-width: 768px) 100vw, 768px"` inside a `relative` container; anything above the fold on the division page gets `priority`. Leave non-storage `src` values (OAuth avatar URLs, `photo` fields that can be arbitrary hosts) as `<img>` — add a one-line comment `{/* arbitrary-host avatar — not in remotePatterns, stays <img> */}` at each skipped site.

- [ ] **Step 5: Verify — tests, typecheck, build, visual**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/image-config.test.ts && npm run typecheck --workspace apps/web`
Expected: PASS.
Run: `npm run build --workspace apps/web`
Expected: builds clean; confirm `apps/web/.next/standalone` contains `sharp` (`ls apps/web/.next/standalone/node_modules | grep sharp` — if missing, add `"sharp"` to `serverExternalPackages` in next.config and rebuild).
Then start the dev server, load a public division page of the demo org (Riverside — see seeded demo accounts), and confirm logos render via `/_next/image?url=…` in the network tab.

- [ ] **Step 6: Commit**

```bash
git add apps/web/next.config.mjs apps/web/package.json package-lock.json \
  apps/web/src/components/public-site "apps/web/src/app/(public)" \
  apps/web/src/lib/__tests__/image-config.test.ts
git commit -m "perf: next/image for storage-served public logos and badges"
```

---

### Task 5: CSP enforcement must never disable caching on public routes

`proxy.ts` stamps a per-request nonce CSP on every page. Today it's report-only; the day `CSP_MODE=enforce` flips, nonce CSP forces dynamic rendering and silently kills ISR (and any CDN) for `/shared`, `/embed`, `/r` (spec P5). Make cacheable public routes permanently report-only + nonce-free, so enforcement of the app surface can proceed safely.

**Files:**
- Modify: `apps/web/src/proxy.ts`
- Test: `apps/web/src/__tests__/proxy-csp.test.ts` (new)

**Interfaces:**
- Produces: exported `isCacheablePublicPath(pathname: string): boolean` from `@/proxy` (used by the test; keep it pure).

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/__tests__/proxy-csp.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, isCacheablePublicPath } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

const page = (path: string) => new NextRequest(`http://localhost:3000${path}`);

describe("CSP vs cacheable public routes", () => {
  it("classifies the cacheable public tree", () => {
    expect(isCacheablePublicPath("/shared/riverside/summer-league")).toBe(true);
    expect(isCacheablePublicPath("/embed/divisions/x/standings")).toBe(true);
    expect(isCacheablePublicPath("/r/AB12CD")).toBe(true);
    expect(isCacheablePublicPath("/dashboard")).toBe(false);
    expect(isCacheablePublicPath("/register")).toBe(false); // /r prefix must not over-match
  });

  it("keeps report-only CSP on cacheable public pages even in enforce mode", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/shared/riverside/summer-league"));
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("Content-Security-Policy-Report-Only")).toContain("default-src 'self'");
  });

  it("enforces on app pages when CSP_MODE=enforce", () => {
    vi.stubEnv("CSP_MODE", "enforce");
    const res = proxy(page("/dashboard"));
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- run src/__tests__/proxy-csp.test.ts`
Expected: FAIL — `isCacheablePublicPath` not exported; enforce mode currently applies everywhere.

- [ ] **Step 3: Implement in `proxy.ts`**

Add above `cspHeader`:

```ts
// ISR/CDN-cacheable public surfaces (spec 2026-07-12 P5): nonce CSP forces
// dynamic rendering, so these trees stay Report-Only permanently — flipping
// CSP_MODE=enforce hardens the app surface without un-caching spectator pages.
// /r is the registration-ref tree (/r/[ref]); keep the segment boundary so
// e.g. /reset-password never matches.
const CACHEABLE_PUBLIC = /^\/(shared|embed|r)(\/|$)/;

export function isCacheablePublicPath(pathname: string): boolean {
  return CACHEABLE_PUBLIC.test(pathname);
}
```

Change `cspHeader(nonce: string)` to `cspHeader(nonce: string, opts: { forceReportOnly?: boolean } = {})` and the name line to:

```ts
  const enforce = process.env.CSP_MODE === "enforce" && !opts.forceReportOnly;
```

In `proxy()`, replace the page-request block's CSP wiring:

```ts
  const cacheable = isCacheablePublicPath(request.nextUrl.pathname);
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = cspHeader(nonce, { forceReportOnly: cacheable });

  const requestHeaders = new Headers(request.headers);
  if (!cacheable) {
    // Nonce request headers make Next stamp scripts per-request; cacheable
    // trees skip them so the HTML stays byte-stable for ISR/CDN.
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set(csp.name, csp.value);
  }
```

(Keep setting `csp.name`/`csp.value` on the **response** for both cases.)

- [ ] **Step 4: Run tests**

Run: `npm run test --workspace apps/web -- run src/__tests__/proxy-csp.test.ts && npm run typecheck --workspace apps/web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/proxy.ts apps/web/src/__tests__/proxy-csp.test.ts
git commit -m "perf: cacheable public routes keep report-only nonce-free CSP under enforce mode"
```

---

### Task 6: Take awaited non-critical work off the scoring hot path

`scoreEvent`'s realtime publishes are already fire-and-forget (`void publish…`, `scoring.ts:93-97`), but the discovery invalidation is awaited in-request (`scoring.ts:372`). Add a `deferred()` helper on Next's `after()` (runs post-response; inline fallback outside a request scope so vitest/scripts keep working) and move the discovery tail onto it.

**Files:**
- Create: `apps/web/src/lib/deferred.ts`
- Modify: `apps/web/src/server/usecases/scoring.ts` (~lines 370-374)
- Test: `apps/web/src/lib/__tests__/deferred.test.ts` (new)

**Interfaces:**
- Produces: `deferred(fn: () => Promise<unknown> | unknown): void` from `@/lib/deferred`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/__tests__/deferred.test.ts
import { describe, expect, it, vi } from "vitest";
import { deferred } from "@/lib/deferred";

describe("deferred", () => {
  it("runs the callback inline when outside a Next request scope", async () => {
    const fn = vi.fn(async () => {});
    deferred(fn);
    await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
  });

  it("swallows callback rejections", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(() => deferred(fn)).not.toThrow();
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/deferred.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/deferred.ts`**

First read `node_modules/next/dist/docs` for the `after` API in this Next version (search: `grep -rn "after" node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md | head`). Then:

```ts
import "server-only";
import { after } from "next/server";

/**
 * Run non-critical tail work AFTER the response streams (Next `after()`),
 * falling back to inline fire-and-forget outside a request scope (vitest,
 * scripts) — same contract as fire*Revalidate's try/catch. Never throws,
 * never delays the caller.
 */
export function deferred(fn: () => Promise<unknown> | unknown): void {
  const run = () => {
    try {
      void Promise.resolve(fn()).catch((err) => console.warn("[deferred] task failed:", err));
    } catch (err) {
      console.warn("[deferred] task failed:", err);
    }
  };
  try {
    after(run);
  } catch {
    run(); // outside a request scope
  }
}
```

- [ ] **Step 4: Apply in `scoring.ts`**

Replace (around lines 370-374, inside the discovery-relevant branch):

```ts
      await invalidateDiscoveryCache();
      fireDiscoveryRevalidate();
```

with:

```ts
      deferred(async () => {
        await invalidateDiscoveryCache();
        fireDiscoveryRevalidate();
      });
```

Import `deferred` from `@/lib/deferred`. Do **not** touch line 291's `await recomputeStandings(...)` — standings must be committed before the response — nor line 368's `fireDivisionRevalidate` (already sync-cheap + broadcast is void).

- [ ] **Step 5: Run scoring + full suites**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/deferred.test.ts src/server/usecases/__tests__`
Expected: PASS. If a scoring/discovery test asserted the cache was invalidated synchronously after `scoreEvent` resolved, wrap the assertion in `vi.waitFor` (the inline fallback resolves on the microtask queue).
Run: `npm run typecheck --workspace apps/web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/deferred.ts apps/web/src/lib/__tests__/deferred.test.ts \
  apps/web/src/server/usecases/scoring.ts
git commit -m "perf: defer discovery invalidation off the scoring hot path"
```

---

### Task 7: CDN purge seam + cache-header e2e guard + ops checklist

Next already emits `s-maxage`/`stale-while-revalidate` on ISR responses (`node_modules/next/dist/docs/01-app/02-guides/cdn-caching.md`). Add the app-side purge hook (fail-open, debounced `purge_everything` — right-sized for a site this small; targeted purge is a later refinement), call it from the same revalidation seam, and pin the header contract with an e2e test so a rendering change can't silently un-cache the public tree.

**Files:**
- Create: `apps/web/src/lib/cdn-purge.ts`
- Modify: `apps/web/src/server/public-site/revalidate.ts`
- Test: `apps/web/src/lib/__tests__/cdn-purge.test.ts` (new)
- Test: `apps/web/e2e/public-cache-headers.spec.ts` (new — follow existing e2e conventions in `apps/web/e2e/`)
- Modify: `docs/superpowers/specs/2026-07-12-architecture-performance-design.md` (append ops checklist)

**Interfaces:**
- Consumes: called from `fireDivisionRevalidate` / `fireOrgRevalidate` / `fireDiscoveryRevalidate` (Task 3's shapes).
- Produces: `purgeCdn(deps?: { fetchFn?: typeof fetch; now?: () => number }): Promise<void>` from `@/lib/cdn-purge`; env contract `CDN_PURGE_URL` (full purge endpoint, e.g. `https://api.cloudflare.com/client/v4/zones/<zone-id>/purge_cache`) + `CDN_PURGE_TOKEN`; also exports `__resetPurgeDebounceForTests(): void`.

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/web/src/lib/__tests__/cdn-purge.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { purgeCdn, __resetPurgeDebounceForTests } from "@/lib/cdn-purge";

beforeEach(() => __resetPurgeDebounceForTests());
afterEach(() => vi.unstubAllEnvs());

function arm() {
  vi.stubEnv("CDN_PURGE_URL", "https://api.cloudflare.com/client/v4/zones/z1/purge_cache");
  vi.stubEnv("CDN_PURGE_TOKEN", "tok");
}

describe("purgeCdn", () => {
  it("no-ops without CDN env", async () => {
    const fetchFn = vi.fn();
    await purgeCdn({ fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("POSTs purge_everything with the bearer token", async () => {
    arm();
    const fetchFn = vi.fn(async () => new Response("{}"));
    await purgeCdn({ fetchFn });
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("/purge_cache");
    expect(init.headers.authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ purge_everything: true });
  });

  it("debounces to one purge per 30s window", async () => {
    arm();
    const fetchFn = vi.fn(async () => new Response("{}"));
    let t = 1_000_000;
    const now = () => t;
    await purgeCdn({ fetchFn, now });
    await purgeCdn({ fetchFn, now }); // same instant — skipped
    t += 31_000;
    await purgeCdn({ fetchFn, now });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("swallows network failures (fail-open)", async () => {
    arm();
    await expect(
      purgeCdn({ fetchFn: vi.fn(async () => Promise.reject(new Error("down"))) }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/cdn-purge.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/cdn-purge.ts`**

```ts
import "server-only";

// CDN purge hook (spec 2026-07-12 §3 A-step 1). Fail-open + debounced
// purge_everything: at this site's size a full purge every ≤30s window is
// cheaper-simpler than tag→URL mapping, and CDN staleness stays bounded by
// s-maxage even when a purge is missed. Targeted per-URL purge is a later
// refinement at this same seam. Multi-machine: each machine debounces
// independently — worst case N purges per window, still idempotent.
const PURGE_DEBOUNCE_MS = 30_000;
let lastPurgeAt = 0;

export function __resetPurgeDebounceForTests(): void {
  lastPurgeAt = 0;
}

export async function purgeCdn(
  deps: { fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<void> {
  const url = process.env.CDN_PURGE_URL;
  const token = process.env.CDN_PURGE_TOKEN;
  if (!url || !token) return;
  const now = deps.now ?? Date.now;
  if (now() - lastPurgeAt < PURGE_DEBOUNCE_MS) return;
  lastPurgeAt = now();
  try {
    await (deps.fetchFn ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ purge_everything: true }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // fail open — s-maxage bounds staleness
  }
}
```

- [ ] **Step 4: Wire into the revalidation seam**

In `server/public-site/revalidate.ts`, add `import { purgeCdn } from "@/lib/cdn-purge";` and append `void purgeCdn();` as the last line of `fireDivisionRevalidate`, `fireOrgRevalidate`, and `fireDiscoveryRevalidate` (after the Task 3 `broadcastRevalidate` lines).

- [ ] **Step 5: Run unit tests**

Run: `npm run test --workspace apps/web -- run src/lib/__tests__/cdn-purge.test.ts && npm run typecheck --workspace apps/web`
Expected: PASS.

- [ ] **Step 6: Pin the ISR header contract with e2e**

First check how existing specs boot/authenticate (`ls apps/web/e2e`, read one public-page spec). ISR `Cache-Control` headers only appear on production builds — `next dev` serves everything dynamic. Follow whichever pattern the e2e suite uses for prod-build assertions; if the suite only runs against dev, gate on it:

```ts
// apps/web/e2e/public-cache-headers.spec.ts
import { expect, test } from "@playwright/test";

// Guards spec 2026-07-12 P1/P5: the public tree must stay ISR-cacheable —
// a stray cookies()/nonce read would flip it to private,no-store and
// silently detach any CDN. Prod-build servers only (dev is always dynamic).
test("public division page emits s-maxage for CDN caching", async ({ request, baseURL }) => {
  const probe = await request.get(`${baseURL}/`);
  test.skip(probe.headers()["cache-control"]?.includes("no-store") === undefined && process.env.CI !== "true", "requires prod build");

  const res = await request.get(`${baseURL}/shared/riverside/summer-league`);
  expect(res.status()).toBe(200);
  const cc = res.headers()["cache-control"] ?? "";
  expect(cc).toContain("s-maxage=30");
  expect(cc).toContain("stale-while-revalidate");
});
```

> The seeded demo org/competition slugs come from the e2e fixtures — reuse whatever `/shared/...` URL an existing public e2e spec visits instead of the literal above. If the suite has no prod-build project, mark the test `test.fixme` with a comment pointing at the CI smoke job and assert there instead — do not ship a green-but-vacuous test.

Run: `npx playwright test e2e/public-cache-headers.spec.ts --project=parallel` (from `apps/web`)
Expected: PASS on prod build, or documented skip on dev.

- [ ] **Step 7: Append the ops checklist to the spec doc**

Append to `docs/superpowers/specs/2026-07-12-architecture-performance-design.md`:

```markdown
## 7. Ops checklist (post-merge, no code)

1. Custom domain → Cloudflare DNS (proxied). fly.dev cannot sit behind a CDN.
2. Cloudflare cache rules: cache `/shared/*`, `/embed/*`, `/r/*`, `/_next/static/*`,
   `/_next/image*`; **respect origin Cache-Control**; include the `_rsc` query
   param in the cache key (bundled guide: cdn-caching.md); never cache `/api/*`,
   `/o/*`, `/dashboard`.
3. Secrets: `fly secrets set DATABASE_URL=<session-pooler :5432 URL> DB_POOL_MAX=10
   PEER_REVALIDATE=1 CDN_PURGE_URL=<cloudflare purge endpoint> CDN_PURGE_TOKEN=<token>`.
4. `fly deploy` picks up min 2 machines / 1gb from fly.toml.
5. Baseline + after: Sentry p50/p75/p95 TTFB for `/shared|/embed` vs `/o/…` vs
   `/api/v1`; Fly CPU/memory high-water on a matchday; Cloudflare cache-hit ratio.
6. Verify prepared statements active: `select count(*) from pg_prepared_statements`
   on the session pooler while browsing the console.
```

- [ ] **Step 8: Full-suite verification + commit + PR**

Run: `npm run typecheck --workspace apps/web && npm run test && npm run build --workspace apps/web`
Expected: all green.

```bash
git add apps/web/src/lib/cdn-purge.ts apps/web/src/lib/__tests__/cdn-purge.test.ts \
  apps/web/src/server/public-site/revalidate.ts apps/web/e2e/public-cache-headers.spec.ts \
  docs/superpowers/specs/2026-07-12-architecture-performance-design.md
git commit -m "perf: CDN purge seam, public cache-header guard, ops checklist"
```

Then push the branch and open a PR titled `perf: Approach A — monolith tuning (spec 2026-07-12)`; body lists the seven slices + ops checklist pointer, ends with the repo's standard generated-with footer.

---

## Plan self-review notes

- **Spec coverage:** A1 CDN → Task 7 (+ops checklist); A2 pooler → Task 1; A3 slug cache → Task 2; A4 images → Task 4; A5 machines (+the multi-instance coherence gap found in review) → Task 3; A6 CSP → Task 5; A7 scoring tail → Task 6. Baseline metrics → Task 7 ops checklist §5. Full coverage.
- **Known judgment calls:** peer-broadcast over Redis `cacheHandler` (30s-ISR contract makes bounded staleness acceptable; the seam is documented for a Cloud Run swap); `purge_everything` over tag→URL mapping (site size); positive-only slug caching (rename correctness).
- **Smoke/demo rule:** no new user-facing feature in this wave — `scripts/smoke.ts` needs no extension, but must pass in CI as-is.
