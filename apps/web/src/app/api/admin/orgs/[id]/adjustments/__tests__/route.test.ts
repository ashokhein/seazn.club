// GET /api/admin/orgs/[id]/adjustments — the SPEC-3 §3 unified adjustments-log
// read route. requireStaff, the org-exists check and adjustmentsForOrg are
// mocked so this asserts the ROUTE's own contract: the entries envelope, the
// 401 auth boundary, 404 on an unknown org, and the strict query schema. The
// derivation/filtering/paging is covered by the DB-backed usecase test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/errors";
import type { StaffRole } from "@/lib/admin";

const requireStaffMock =
  vi.fn<() => Promise<{ id: string; staff_role: StaffRole | null }>>();
vi.mock("@/lib/admin", () => ({
  requireStaff: () => requireStaffMock(),
}));

const sqlMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }[]>>();
vi.mock("@/lib/db", () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
}));

const adjustmentsForOrgMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
vi.mock("@/server/usecases/admin-adjustments-log", () => ({
  adjustmentsForOrg: (...args: unknown[]) => adjustmentsForOrgMock(...args),
}));

import { GET } from "../route";

const get = (id: string, qs = "") =>
  GET(new Request(`http://test/api/admin/orgs/${id}/adjustments${qs}`), {
    params: Promise.resolve({ id }),
  });

const ENTRY = {
  id: "log-1",
  actorId: "staff-1",
  actorName: "Casey",
  action: "credit_adjust",
  category: "credits",
  detail: { reason_code: "promo" },
  reason: "promo",
  reversible: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  requireStaffMock.mockReset().mockResolvedValue({ id: "staff-1", staff_role: "support" });
  sqlMock.mockReset().mockResolvedValue([{ id: "org-1" }]);
  adjustmentsForOrgMock.mockReset().mockResolvedValue([ENTRY]);
});

describe("GET /api/admin/orgs/[id]/adjustments", () => {
  it("returns the entries envelope for any staff", async () => {
    const res = await get("org-1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { ok: true, entries: [ENTRY] } });
    expect(adjustmentsForOrgMock).toHaveBeenCalledWith("org-1", { limit: undefined, before: undefined });
  });

  it("passes limit + before through to the usecase", async () => {
    await get("org-1", "?limit=10&before=2026-01-02T00:00:00.000Z");
    expect(adjustmentsForOrgMock).toHaveBeenCalledWith("org-1", {
      limit: 10,
      before: "2026-01-02T00:00:00.000Z",
    });
  });

  it("rejects a non-staff caller before touching the DB", async () => {
    requireStaffMock.mockRejectedValueOnce(new AuthError("Staff access required"));
    const res = await get("org-1");
    expect(res.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(adjustmentsForOrgMock).not.toHaveBeenCalled();
  });

  it("404s an unknown org without reading the log", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await get("org-missing");
    expect(res.status).toBe(404);
    expect(adjustmentsForOrgMock).not.toHaveBeenCalled();
  });

  it("400s a non-numeric limit", async () => {
    const res = await get("org-1", "?limit=abc");
    expect(res.status).toBe(400);
    expect(adjustmentsForOrgMock).not.toHaveBeenCalled();
  });

  it("400s a non-positive limit", async () => {
    const res = await get("org-1", "?limit=0");
    expect(res.status).toBe(400);
  });

  it("400s a malformed before cursor", async () => {
    const res = await get("org-1", "?before=not-a-date");
    expect(res.status).toBe(400);
  });
});
