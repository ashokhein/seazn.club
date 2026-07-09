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

function getClient(): Sql {
  if (globalForDb._sql) return globalForDb._sql;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and add your Supabase connection string.",
    );
  }
  // Supabase requires SSL; a local Postgres rejects it. Auto-detect, with an
  // optional override via DATABASE_SSL=require|disable.
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const sslEnv = process.env.DATABASE_SSL;
  const ssl =
    sslEnv === "disable"
      ? false
      : sslEnv === "require"
        ? "require"
        : isLocal
          ? false
          : "require";

  // Supabase's transaction pooler (port 6543) does not support prepared
  // statements; disable them in that case.
  const prepare = !url.includes(":6543");

  // The app lives in a dedicated schema (see db/flyway.toml). Pin it on the
  // connection startup packet so every query — including `withTenant`'s
  // `set local role app_user` transactions — resolves unqualified names there.
  const schema = process.env.DB_SCHEMA ?? "seazn_club";

  const client = postgres(url, {
    ssl,
    prepare,
    max: 5,
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
  if (process.env.NODE_ENV !== "production") globalForDb._sql = client;
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
