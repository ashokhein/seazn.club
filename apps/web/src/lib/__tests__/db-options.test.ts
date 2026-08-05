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
