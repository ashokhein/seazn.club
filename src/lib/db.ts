import postgres from "postgres";

type Sql = ReturnType<typeof postgres>;

/**
 * Lazily-initialised postgres client.
 *
 * DATABASE_URL should be the Supabase connection string (URI). Use the
 * "Session pooler" connection string for serverless friendliness. The client
 * is created on first use so that importing this module never throws during
 * the build when env vars are not present.
 */
const globalForDb = globalThis as unknown as { _sql?: Sql };

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

  const client = postgres(url, {
    ssl,
    prepare,
    max: 5,
    idle_timeout: 20,
    connect_timeout: 15,
  });
  if (process.env.NODE_ENV !== "production") globalForDb._sql = client;
  return client;
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
