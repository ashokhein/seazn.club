import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;

/**
 * Lazily-initialised postgres client.
 *
 * DATABASE_URL should be the Supabase connection string (URI). Use the
 * "Session pooler" connection string for serverless friendliness. The client
 * is created on first use so that importing this module never throws during
 * the build when env vars are not present.
 */
const globalForDb = globalThis as unknown as { _sql?: Sql; _queryCount?: number };

/**
 * Number of statements sent to Postgres since process start. Regression tests
 * use this to pin the round-trip budget of hot paths (fixture generation);
 * the counter is a monotonic total, so tests diff before/after.
 */
export function statementCount(): number {
  return globalForDb._queryCount ?? 0;
}

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

function getClient(): Sql {
  if (globalForDb._sql) return globalForDb._sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and add your Supabase connection string.",
    );
  }
  const { ssl, prepare, max, schema } = connectionOptions(url);

  const client = postgres(url, {
    ssl,
    prepare,
    max,
    idle_timeout: 20,
    connect_timeout: 15,
    connection: { search_path: schema },
    debug: () => {
      globalForDb._queryCount = (globalForDb._queryCount ?? 0) + 1;
    },
    types: {
      // Plain `date` columns (starts_on, ends_on, dob) stay 'YYYY-MM-DD'
      // strings — the API contracts declare them as strings and React can't
      // render Date objects. timestamptz keeps the default Date parsing.
      date: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => v,
        parse: (v: string) => v,
      },
    },
  });
  // Stash unconditionally: getClient() is called lazily per sql-proxy access,
  // so without this every production query built a fresh client (its own
  // pool) — one page render held 25+ connections and exhausted stg's 60
  // slots (FATAL 53300, 2026-07-13 outage). The globalThis stash doubles as
  // the dev-HMR survivor.
  globalForDb._sql = client;
  return client;
}

// ─── The nesting guard ───────────────────────────────────────────────────────
//
// THE BUG IT EXISTS FOR. `withTenant` is `getClient().begin()`, which PINS one
// connection of a `max: 5` pool for the whole callback. Anything inside that
// callback which asks the pool for a SECOND connection — a query on the pooled
// `sql` proxy (an entitlement helper, a cache-miss lookup) or another
// `withTenant` — is a self-deadlock waiting for load: five concurrent requests
// reaching such a line pin all five slots and queue for a sixth that can never
// exist. postgres.js has NO queue-wait timeout, so it is permanent. The process
// sits at ~0% CPU serving static routes 200 while every DB-touching route,
// `/api/health` included, hangs for ever. Observed live twice on 2026-08-05.
//
// WHY A RUNTIME GUARD AND NOT A GREP. The nesting is almost never visible at
// the call site: `assertCompetitionNotFrozen(orgId, id, tx)` reads as though
// passing `tx` made it safe, and it did not — the helper it delegates to opens
// with `getLimit`, which is pooled, before the `tx` branch is ever reached. A
// static sweep over that shape under-reports, and the transitive call graph is
// deep enough (usecase -> freeze helper -> getLimit -> resolve -> cache miss ->
// query) that "does this path touch the pool" is not a question source code
// answers reliably. Asking the RUNTIME is exact.
//
// OFF BY DEFAULT, AND PRODUCTION NEVER ENTERS IT. Without the env var set
// `withTenant` does not even establish the AsyncLocalStorage context, so the
// cost is one `process.env` read per transaction and the behaviour is
// byte-identical to having no guard at all. It is a test instrument, not a
// production safety net.
//
//   DB_NESTING_GUARD=1        throw on the offending call (tests, tripwires)
//   DB_NESTING_GUARD=record   record and allow — enumerate every site in one run
//
// See `server/usecases/__tests__/pool-nesting-tripwire.test.ts`.

interface TxFrame {
  orgId: string;
}
const txFrame = new AsyncLocalStorage<TxFrame>();

/** Every nesting seen since process start, in order. Only populated while the
 *  guard is on; `record` mode is what makes a single suite run enumerate the
 *  whole codebase instead of stopping at the first offender. */
const violations: string[] = [];

/** What the guard saw. Empty when the guard is off. */
export function nestingViolations(): readonly string[] {
  return violations;
}

/** Test hook — a fresh slate per case. */
export function clearNestingViolations(): void {
  violations.length = 0;
}

function guardMode(): "off" | "throw" | "record" {
  const v = process.env.DB_NESTING_GUARD;
  return v === "1" || v === "throw" ? "throw" : v === "record" ? "record" : "off";
}

/**
 * Called at every point that would take a SECOND connection from the pool.
 * A no-op unless the guard is on AND a `withTenant` transaction is open on this
 * async context.
 */
function reportNesting(what: string): void {
  const mode = guardMode();
  if (mode === "off") return;
  if (txFrame.getStore() === undefined) return;
  // The stack is the whole value of the report: it names the helper chain that
  // reached the pool, which is the part no call site shows.
  const site = new Error(
    `connection-pool nesting: ${what} was issued while a withTenant transaction ` +
      `was already holding a pooled connection. In production (max: 5) five ` +
      `concurrent requests reaching this line pin every slot and hang the process ` +
      `permanently — postgres.js has no queue-wait timeout. Finish and CLOSE the ` +
      `transaction first, then do the pooled work (see lib/db.ts).`,
  );
  violations.push(site.stack ?? site.message);
  if (mode === "throw") throw site;
}

/**
 * Run `fn` inside a transaction with the tenant context set. The `app_user`
 * role (non-superuser) is activated for the transaction so RLS policies
 * enforce org isolation. All tournament mutations must go through this.
 *
 * MUST NOT be called from inside another `withTenant` callback, and must not
 * await anything that queries the pooled `sql` proxy — see the nesting guard
 * above for what that costs.
 */
export async function withTenant<T>(
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // postgres types begin() as Promise<UnwrapPromiseArray<T>>; for non-array T
  // this equals T at runtime but TS can't prove it — safe cast.
  const run = (): Promise<T> =>
    getClient().begin(async (tx) => {
      await tx`select set_config('app.current_org', ${orgId}, true)`;
      await tx`set local role app_user`;
      return fn(tx);
    }) as unknown as Promise<T>;

  if (guardMode() === "off") return run();
  // A nested withTenant is the same pool checkout by another name — it calls
  // `getClient().begin()` directly and so never passes through the `sql` proxy.
  reportNesting("withTenant()");
  return txFrame.run({ orgId }, run);
}

/**
 * A tagged-template call — `sql`select 1`` — as opposed to a FRAGMENT builder
 * (`sql(columns)`, `sql.json(x)`), which composes into someone else's query and
 * takes no connection of its own. Only the former is a pool checkout, and
 * conflating the two is what made a static sweep of this file's callers report
 * five registrations.ts sites that were never nesting at all.
 */
function isTaggedTemplate(args: unknown[]): boolean {
  const first = args[0];
  return Array.isArray(first) && "raw" in (first as object);
}

/** Property access on the pooled client that TAKES a connection. `json`,
 *  `array`, `types` and friends are serialisers and do not. */
const CONNECTION_METHODS = new Set(["begin", "unsafe", "reserve", "listen", "notify", "file"]);

// A Proxy that forwards both tagged-template calls and method access
// (sql.begin, sql.json, ...) to the lazily-created client.
export const sql = new Proxy((() => {}) as unknown as Sql, {
  apply(_target, _thisArg, args: unknown[]) {
    if (isTaggedTemplate(args)) reportNesting("a query on the pooled `sql` proxy");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getClient() as any)(...args);
  },
  get(_target, prop: string | symbol) {
    if (typeof prop === "string" && CONNECTION_METHODS.has(prop)) reportNesting(`sql.${prop}()`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = getClient() as any;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as Sql;
