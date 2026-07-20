// Task 11: POST /api/admin/orgs/[id]/restore-trial had no route test. Mirrors
// the sibling remove-payment-method route test idiom (api/admin/orgs/[id]/
// remove-payment-method/__tests__/route.test.ts): guard + org-exists + usecase
// call are all mocked so this asserts the ROUTE's own contract (auth boundary,
// 404, schema), not restoreTrial's own liveness/audit behaviour — that is
// covered where restoreTrial itself lives.
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

const restoreTrialMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock("@/server/usecases/admin-plan", () => ({
  restoreTrial: (...args: unknown[]) => restoreTrialMock(...args),
}));

import { POST } from "../route";

const post = (id: string, body: unknown) =>
  POST(
    new Request(`http://test/api/admin/orgs/${id}/restore-trial`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  requireStaffMock.mockReset().mockResolvedValue({ id: "staff-1" });
  sqlMock.mockReset().mockResolvedValue([{ id: "org-1" }]);
  restoreTrialMock.mockReset().mockResolvedValue(undefined);
});

describe("POST /api/admin/orgs/[id]/restore-trial", () => {
  it("calls restoreTrial with the staff actor, org id and reason", async () => {
    const res = await post("org-1", { reason: "comp turned into a paid pilot" });
    expect(res.status).toBe(200);
    // handler() wraps a route's own returned object as { ok: true, data: <it> }
    // (see lib/http.ts) — the route returns { ok: true } itself, so the JSON
    // body nests it under `data` rather than flattening.
    expect(await res.json()).toEqual({ ok: true, data: { ok: true } });
    expect(restoreTrialMock).toHaveBeenCalledWith(
      "staff-1",
      "org-1",
      "comp turned into a paid pilot",
    );
  });

  // This codebase's admin-route contract is 401 for a non-staff caller,
  // never 403 — requireStaff throws AuthError, which the shared handler()
  // (lib/http.ts) maps to 401 across every /api/admin/** route (see
  // api/admin/entitlements's own "rejects non-staff callers" test and the
  // sibling remove-payment-method route test).
  it("rejects a non-staff caller before touching the DB or the usecase", async () => {
    requireStaffMock.mockRejectedValueOnce(new AuthError("Staff access required"));
    const res = await post("org-1", { reason: "comp turned into a paid pilot" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(restoreTrialMock).not.toHaveBeenCalled();
  });

  it("404s on an unknown org before calling the usecase", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await post("org-missing", { reason: "x" });
    expect(res.status).toBe(404);
    expect(restoreTrialMock).not.toHaveBeenCalled();
  });

  it("400s on a missing reason before calling the usecase (schema, not the usecase's own check)", async () => {
    const res = await post("org-1", { reason: "" });
    expect(res.status).toBe(400);
    expect(restoreTrialMock).not.toHaveBeenCalled();
  });

  it("400s on an unknown field (strict schema)", async () => {
    const res = await post("org-1", { reason: "x", extra: "nope" });
    expect(res.status).toBe(400);
    expect(restoreTrialMock).not.toHaveBeenCalled();
  });
});
