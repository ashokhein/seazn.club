import postgres from "postgres";

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

/**
 * Run `fn` inside a transaction with the tenant context set. The `app_user`
 * role (non-superuser) is activated for the transaction so RLS policies
 * enforce org isolation. All tournament mutations must go through this.
 */
export async function withTenant<T>(
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // postgres types begin() as Promise<UnwrapPromiseArray<T>>; for non-array T
  // this equals T at runtime but TS can't prove it — safe cast.
  return getClient().begin(async (tx) => {
    await tx`select set_config('app.current_org', ${orgId}, true)`;
    await tx`set local role app_user`;
    return fn(tx);
  }) as unknown as T;
}

/** Seconds an ORPHANED lock connection lingers before closing itself. */
const LOCK_IDLE_TIMEOUT_S = 10;
/** Comfortably inside `LOCK_IDLE_TIMEOUT_S`, so a slow beat cannot let the
 *  connection idle out between two of them. */
const LOCK_KEEPALIVE_MS = 4_000;
/** How long the `finally` will wait for its explicit unlock before giving up on
 *  it and closing the connection instead. See the release block below. */
const LOCK_UNLOCK_TIMEOUT_MS = 3_000;

/**
 * Resolve with `p`'s value, or with `undefined` once `ms` has elapsed —
 * whichever happens first.
 *
 * Exported because it is the only part of the bounded release below that can be
 * tested without socket-level fault injection: pass a promise that never
 * settles and the caller still has to come back.
 */
export function settleWithin<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms);
      // Never a reason for the process to stay alive: if the race is already
      // decided this timer is pure garbage waiting to be collected.
      timer.unref?.();
    }),
  ]);
}

/**
 * What `withSessionLocks` hands its body so the body can ask whether the locks
 * are still real.
 */
export interface SessionLockHandle {
  /**
   * Are this call's keys still held, RIGHT NOW? A LIVE check, not a snapshot —
   * read it again before each unit of work the lock is supposed to protect,
   * because it can go from true to false part-way through a loop.
   *
   * False means: the backend that took the keys is gone, so nothing is being
   * excluded any more. It never goes back to true — a reconnected backend does
   * not re-acquire what the old one held.
   */
  held(): boolean;
}

/**
 * The wait for a session advisory lock ran out (Postgres 55P03), which can only
 * happen when the caller asked for a `lockTimeoutMs`.
 *
 * Deliberately not an `HttpError`: this module has no business choosing a status
 * code, and the callers that bound their wait each have their own retryable
 * answer to give. Callers that do NOT pass a timeout never see this.
 */
export class SessionLockTimeoutError extends Error {
  constructor(readonly key: string) {
    super(`timed out waiting for the session advisory lock ${key}`);
    this.name = "SessionLockTimeoutError";
  }
}

/**
 * Hold SESSION-level advisory locks across `fn`, on a connection OUTSIDE the
 * pool, and release them however `fn` ends.
 *
 * Why not a pooled connection: a pinned one would still need a SECOND pool slot
 * for every statement `fn` runs. At `DB_POOL_MAX` 5, five concurrent holders pin
 * all five and nothing can make progress — this repo has already had exactly
 * that stall (docs/superpowers/plans/2026-07-21-billing-groups-remaining.md).
 * Raising the pool is not available either: the connection budget is
 * machines x DB_POOL_MAX + Flyway + headroom + Supabase baseline, and blowing it
 * is what caused the FATAL 53300 outage noted in getClient() above.
 *
 * LEAK MODEL. Session locks die with their backend, so a crashed process
 * releases them. The bad case is a connection left ALIVE that the code has
 * forgotten about, so: the client is created INSIDE the try (no path can open
 * one without reaching the finally), `idle_timeout` is short so an orphan closes
 * itself within seconds instead of holding the key indefinitely, and `end()` is
 * bounded so a hanging close cannot strand it either. Callers that WAIT on these
 * keys should bound their wait too — `lockTimeoutMs` below does that for a
 * caller of this helper; `applyCompetitionSchedule` does the transaction-level
 * equivalent with `set local lock_timeout`.
 *
 * HEARTBEAT, and why the lock is worthless without one. This connection is idle
 * BY DESIGN for the whole of `fn` — everything `fn` runs goes through the pool —
 * so `idle_timeout` closes it mid-body and the backend takes the lock with it,
 * silently. Measured against Postgres: a holder lost its key 10.4s after the
 * last statement, i.e. any body longer than `idle_timeout` ran unprotected past
 * that point while still believing it held the lock. A beat keeps the backend
 * alive while `fn` runs, and stops the instant it ends so the orphan self-heal
 * above still applies.
 *
 * WHY THE BEAT COMPARES A PID, and why a ping alone would be worse than nothing.
 * postgres.js reconnects transparently (`reconnect()` on close, `connect(query)`
 * requeues), and this connection is idle for almost all of `fn`, so a drop — a
 * pooler restart, a network reset, a server-side termination — lands BETWEEN
 * beats. A `select 1` then opens a NEW backend and SUCCEEDS. The advisory locks
 * died with the old backend, `fn` carries on believing it excludes everyone, and
 * the release below runs against a backend that never held anything: a ping-only
 * keepalive makes that failure INVISIBLE rather than fixing it. Comparing
 * `pg_backend_pid()` to the pid the keys were taken on is what tells a live lock
 * from a live connection, and `fn` is told through `SessionLockHandle.held()`
 * so it can stop while it still has a truthful report to give. This helper
 * deliberately does NOT throw on a lost lock: whatever `fn` already committed is
 * committed, and discarding its answer would leave the caller with no record of
 * work that really happened.
 */
export async function withSessionLocks<T>(
  keys: readonly string[],
  fn: (lock: SessionLockHandle) => Promise<T>,
  opts: { lockTimeoutMs?: number } = {},
): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — cannot take a session lock.");
  // Supabase's TRANSACTION pooler (:6543) hands consecutive statements to
  // DIFFERENT backends, so the lock would be held by a backend nothing else
  // ever speaks to: no exclusion at all, and nothing to say so. That is the one
  // failure mode here that would be invisible in production, so refuse rather
  // than serve a lock that does nothing. Prod is the SESSION pooler (:5432,
  // fly.toml), where a backend is pinned per client connection.
  if (url.includes(":6543")) {
    throw new Error(
      "session advisory locks require the session pooler (:5432) or a direct " +
        "connection — the transaction pooler (:6543) does not pin a backend.",
    );
  }
  const { ssl, prepare, schema } = connectionOptions(url);
  let client: Sql | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  try {
    client = postgres(url, {
      ssl,
      prepare,
      max: 1,
      idle_timeout: LOCK_IDLE_TIMEOUT_S,
      connect_timeout: 15,
      connection: { search_path: schema },
    });
    if (opts.lockTimeoutMs !== undefined) {
      // `set_config` rather than `set`: SET takes no bind parameters, so `set`
      // would need string interpolation. Session-scoped (is_local false) because
      // there is no transaction here — and this connection belongs to this call
      // alone and is closed below, so it cannot leak onto other work. A bare
      // integer is milliseconds.
      const ms = String(Math.max(1, Math.round(opts.lockTimeoutMs)));
      await client`select set_config('lock_timeout', ${ms}, false)`;
    }
    for (const key of keys) {
      try {
        await client`select pg_advisory_lock(hashtext(${key}))`;
      } catch (err) {
        // 55P03 is reachable ONLY with a lockTimeoutMs — without one the wait is
        // unbounded, so a 55P03 from anywhere else is not ours to translate.
        if (opts.lockTimeoutMs !== undefined && (err as { code?: string }).code === "55P03") {
          throw new SessionLockTimeoutError(key);
        }
        throw err;
      }
    }
    const beating = client;
    // Captured AFTER the last key is acquired, so it is the backend the locks
    // actually live on rather than some earlier connection attempt.
    const [pidRow] = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const lockedPid = pidRow?.pid;
    let lost = false;
    // unref'd so a beat can never be the reason a process stays alive; cleared
    // in the finally regardless of how `fn` ends. A beat that comes back with a
    // DIFFERENT pid means postgres.js silently reconnected and the keys are gone
    // (see the comment above); a beat that REJECTS means this connection is not
    // usable, so it is not holding anything either. Both are one-way.
    beat = setInterval(() => {
      void beating<{ pid: number }[]>`select pg_backend_pid() as pid`.then(
        (rows) => {
          if (rows[0]?.pid !== lockedPid) lost = true;
        },
        () => {
          lost = true;
        },
      );
    }, LOCK_KEEPALIVE_MS);
    beat.unref?.();
    return await fn({ held: () => !lost });
  } finally {
    if (beat) clearInterval(beat);
    if (client) {
      // Both, always, and neither may mask what `fn` threw: a leaked lock
      // connection is worse than never having taken the lock at all.
      //
      // The unlock is BOUNDED, and losing that race is safe: `end()` below
      // closes the backend, and a backend's session locks die with it, so this
      // statement is belt-and-braces rather than the release itself. It needs a
      // bound because a wedged socket (open, no RST) no longer self-heals: it
      // used to go idle, `idle_timeout` closed it locally, and the unlock
      // reconnected under `connect_timeout` — but with a beat always outstanding
      // postgres.js's idle timer never arms, so an unbounded unlock queues
      // behind the wedged beats forever and the CALLER never returns. An HTTP
      // request that hangs until a gateway kills it is a worse outcome than a
      // release that gave up and closed the connection instead.
      await settleWithin(
        client`select pg_advisory_unlock_all()`.catch(() => undefined),
        LOCK_UNLOCK_TIMEOUT_MS,
      );
      await client.end({ timeout: 5 }).catch(() => undefined);
    }
  }
}

// A Proxy that forwards both tagged-template calls and method access
// (sql.begin, sql.json, ...) to the lazily-created client.
export const sql = new Proxy((() => {}) as unknown as Sql, {
  apply(_target, _thisArg, args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getClient() as any)(...args);
  },
  get(_target, prop: string | symbol) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = getClient() as any;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
}) as Sql;
