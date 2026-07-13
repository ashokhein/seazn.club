import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-07-13 incident: in production builds getClient() constructed a brand
// new postgres client (its own pool) on EVERY sql proxy access, because the
// singleton was only stashed when NODE_ENV !== "production". One authed page
// render opened 25+ connections; on stg (max_connections=60, 2 machines) this
// exhausted the slots → FATAL 53300. The client must be constructed exactly
// once per process regardless of NODE_ENV.
const postgresMock = vi.fn(() => {
  const client = () => Promise.resolve([]);
  client.begin = vi.fn();
  return client;
});
vi.mock("postgres", () => ({ default: postgresMock }));

describe("db client singleton", () => {
  beforeEach(() => {
    vi.resetModules();
    postgresMock.mockClear();
    delete (globalThis as { _sql?: unknown })._sql;
    vi.stubEnv("DATABASE_URL", "postgres://app@db.example.com:5432/app");
  });

  it("constructs the postgres client once in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { sql } = await import("@/lib/db");
    void sql.options;
    void sql.options;
    await sql`select 1`;
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });

  it("constructs the postgres client once in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { sql } = await import("@/lib/db");
    void sql.options;
    void sql.options;
    expect(postgresMock).toHaveBeenCalledTimes(1);
  });
});
