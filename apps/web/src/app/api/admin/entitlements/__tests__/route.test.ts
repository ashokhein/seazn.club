// W1 Task 6: PATCH /api/admin/entitlements — superadmin edits one plan cell.
// Mirrors the existing admin-route test idiom (api/admin/revenue): guard +
// side effects (sql / logStaffAction / cacheDelPattern) are mocked so the test
// asserts the contract — superadmin upserts and busts the whole `ent:*` cache,
// a non-staff caller is rejected (AuthError -> 401 via the shared handler), and
// a malformed body 400s before any DB write.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/errors";
import type { AdminEntRow } from "@/lib/entitlement-admin";

const requireSuperadminMock = vi.fn<() => Promise<{ id: string }>>();
const logStaffActionMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock("@/lib/admin", () => ({
  requireSuperadmin: () => requireSuperadminMock(),
  logStaffAction: (...args: unknown[]) => logStaffActionMock(...args),
}));

const sqlMock = vi.fn<(...args: unknown[]) => Promise<AdminEntRow[]>>();
vi.mock("@/lib/db", () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
}));

const cacheDelPatternMock = vi.fn<(pattern: string) => Promise<void>>();
vi.mock("@/lib/cache", () => ({
  cacheDelPattern: (pattern: string) => cacheDelPatternMock(pattern),
}));

import { PATCH } from "../route";

const fixtureRow: AdminEntRow = {
  plan_key: "community",
  feature_key: "clubs.max",
  bool_value: null,
  int_value: 5,
};

const patch = (body: unknown) =>
  PATCH(
    new Request("http://test/api/admin/entitlements", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  requireSuperadminMock.mockReset().mockResolvedValue({ id: "staff-1" });
  logStaffActionMock.mockReset().mockResolvedValue(undefined);
  cacheDelPatternMock.mockReset().mockResolvedValue(undefined);
  sqlMock.mockReset().mockResolvedValue([fixtureRow]);
});

describe("PATCH /api/admin/entitlements", () => {
  it("updates a plan cell, logs the action and busts the whole ent cache", async () => {
    const res = await patch({ plan_key: "community", feature_key: "clubs.max", int_value: 5 });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; data: AdminEntRow };
    expect(json.ok).toBe(true);
    expect(json.data).toEqual(fixtureRow);

    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(logStaffActionMock).toHaveBeenCalledWith(
      "staff-1",
      "entitlement.plan_edit",
      "entitlement",
      "community:clubs.max",
      { plan_key: "community", feature_key: "clubs.max", int_value: 5 },
    );
    expect(cacheDelPatternMock).toHaveBeenCalledWith("ent:*");
  });

  it("accepts int_value null (unlimited) as an explicit edit", async () => {
    await patch({ plan_key: "pro", feature_key: "clubs.max", int_value: null });
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(cacheDelPatternMock).toHaveBeenCalledWith("ent:*");
  });

  it("rejects non-staff callers before touching the DB or cache", async () => {
    requireSuperadminMock.mockRejectedValueOnce(new AuthError("Superadmin access required"));
    const res = await patch({ plan_key: "community", feature_key: "clubs.max", int_value: 5 });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(logStaffActionMock).not.toHaveBeenCalled();
    expect(cacheDelPatternMock).not.toHaveBeenCalled();
  });

  it("400s on an unknown plan_key before any write", async () => {
    const res = await patch({ plan_key: "enterprise", feature_key: "clubs.max", int_value: 5 });
    expect(res.status).toBe(400);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(cacheDelPatternMock).not.toHaveBeenCalled();
  });
});
