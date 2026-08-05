import { describe, expect, it } from "vitest";
import { connectionOptions, settleWithin, withSessionLocks } from "@/lib/db";

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

// The bound on `withSessionLocks`'s release. A wedged socket — open, no RST —
// is invisible to postgres.js: with a keepalive beat always outstanding its idle
// timer never arms, so the release statement queues behind the wedged beats and
// never settles. Unbounded, that is an HTTP request that hangs until a gateway
// kills it, which is why the release has to be able to give up.
describe("settleWithin", () => {
  it("gives up on a promise that never settles instead of waiting for it", async () => {
    const never = new Promise<string>(() => {});
    const started = Date.now();
    await expect(settleWithin(never, 50)).resolves.toBeUndefined();
    // Bounded in the real sense, not "eventually": a caller must not be able to
    // tell a wedged release from a fast one.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns the value when it settles in time — the bound is a ceiling, not a delay", async () => {
    const started = Date.now();
    await expect(settleWithin(Promise.resolve("released"), 30_000)).resolves.toBe("released");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("withSessionLocks", () => {
  const withUrl = async <T>(url: string | undefined, fn: () => Promise<T>): Promise<T> => {
    const before = process.env.DATABASE_URL;
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    try {
      return await fn();
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
    }
  };

  // The transaction pooler gives consecutive statements DIFFERENT backends, so a
  // session lock taken there excludes nobody and says nothing — the one failure
  // mode of this helper that production would never show us. It has to be loud.
  it("refuses the transaction pooler (:6543) instead of holding a lock that excludes nobody", async () => {
    let ran = false;
    await withUrl("postgresql://u:p@aws-0-eu-west-2.pooler.supabase.com:6543/postgres", async () => {
      await expect(
        withSessionLocks(["joint:x"], async () => {
          ran = true;
        }),
      ).rejects.toThrow(/6543|transaction pooler/);
    });
    // …and it refused BEFORE running the body, so no work happens unprotected.
    expect(ran).toBe(false);
  });

  it("refuses when DATABASE_URL is unset rather than connecting to a default", async () => {
    await withUrl(undefined, async () => {
      await expect(withSessionLocks(["joint:x"], async () => undefined)).rejects.toThrow(
        /DATABASE_URL/,
      );
    });
  });
});
