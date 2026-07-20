// Task 6C: POST /api/admin/orgs/[id]/remove-payment-method. Mirrors the
// existing admin-route test idiom (api/admin/entitlements): guard + org-exists
// + usecase call are all mocked so the test asserts the route's own contract,
// not billing-manage.ts's (that's admin-remove-payment-method.test.ts's job).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/errors";

const requireStaffMock = vi.fn<() => Promise<{ id: string }>>();
vi.mock("@/lib/admin", () => ({
  requireStaff: () => requireStaffMock(),
}));

const sqlMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }[]>>();
vi.mock("@/lib/db", () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
}));

const staffRemoveMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock("@/server/usecases/billing-manage", () => ({
  staffRemovePaymentMethod: (...args: unknown[]) => staffRemoveMock(...args),
}));

import { POST } from "../route";

const post = (id: string, body: unknown) =>
  POST(
    new Request(`http://test/api/admin/orgs/${id}/remove-payment-method`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  requireStaffMock.mockReset().mockResolvedValue({ id: "staff-1" });
  sqlMock.mockReset().mockResolvedValue([{ id: "org-1" }]);
  staffRemoveMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/admin/orgs/[id]/remove-payment-method", () => {
  it("calls staffRemovePaymentMethod with the staff actor, org id, card id and reason", async () => {
    const res = await post("org-1", { payment_method_id: "pm_1", reason: "fraud cleanup" });
    expect(res.status).toBe(200);
    // handler() wraps a route's own returned object as { ok: true, data: <it> }
    // (see lib/http.ts) — the route returns { ok: true } itself, so the JSON
    // body nests it under `data` rather than flattening.
    expect(await res.json()).toEqual({ ok: true, data: { ok: true } });
    expect(staffRemoveMock).toHaveBeenCalledWith("staff-1", "org-1", "pm_1", "fraud cleanup");
  });

  // Brief's "non-staff caller 403s": requireStaff throws AuthError, which the
  // shared handler (lib/http.ts) maps to 401 — the SAME contract every other
  // admin/orgs route in this codebase uses (see api/admin/entitlements's own
  // "rejects non-staff callers" test). No route here should invent a 403.
  it("rejects a non-staff caller before touching the DB or the usecase", async () => {
    requireStaffMock.mockRejectedValueOnce(new AuthError("Staff access required"));
    const res = await post("org-1", { payment_method_id: "pm_1", reason: "fraud cleanup" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(staffRemoveMock).not.toHaveBeenCalled();
  });

  it("404s on an unknown org before calling the usecase", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await post("org-missing", { payment_method_id: "pm_1", reason: "x" });
    expect(res.status).toBe(404);
    expect(staffRemoveMock).not.toHaveBeenCalled();
  });

  it("400s on a missing reason before calling the usecase (schema, not the usecase's own check)", async () => {
    const res = await post("org-1", { payment_method_id: "pm_1", reason: "" });
    expect(res.status).toBe(400);
    expect(staffRemoveMock).not.toHaveBeenCalled();
  });

  it("400s on an unknown field (strict schema)", async () => {
    const res = await post("org-1", {
      payment_method_id: "pm_1",
      reason: "x",
      extra: "nope",
    });
    expect(res.status).toBe(400);
    expect(staffRemoveMock).not.toHaveBeenCalled();
  });
});
