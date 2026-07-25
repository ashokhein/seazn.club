// POST /api/admin/orgs/[id]/credits — the SPEC-3 §1/§2 staff credit
// grant/deduct route. Guard, org-exists, wallet resolution, adminAdjust and
// logStaffAction are all mocked so this asserts the ROUTE's own contract:
// the support hard cap (§2 RBAC tiers), the 401 auth boundary, 404, and the
// strict zod schema. adminAdjust's own ledger/idempotency/below-zero behaviour
// is covered in lib/__tests__/credits-admin-adjust.test.ts. Mirrors the
// sibling restore-trial route test idiom.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/errors";
import type { StaffRole } from "@/lib/admin";

const requireStaffMock =
  vi.fn<() => Promise<{ id: string; staff_role: StaffRole | null }>>();
const logStaffActionMock = vi.fn<(...args: unknown[]) => Promise<void>>();
vi.mock("@/lib/admin", () => ({
  requireStaff: () => requireStaffMock(),
  logStaffAction: (...args: unknown[]) => logStaffActionMock(...args),
}));

const sqlMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }[]>>();
vi.mock("@/lib/db", () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
}));

const adminAdjustMock =
  vi.fn<(...args: unknown[]) => Promise<{ applied: boolean; balanceAfter: number }>>();
const walletIdForMock = vi.fn<(...args: unknown[]) => Promise<string>>();
vi.mock("@/lib/credits", () => ({
  adminAdjust: (...args: unknown[]) => adminAdjustMock(...args),
  walletIdFor: (...args: unknown[]) => walletIdForMock(...args),
  // The route maps this typed error to 422; the mock module must export the
  // same class the route imports for the `instanceof` check to hold.
  InsufficientBalanceError: class InsufficientBalanceError extends Error {},
}));

import { POST } from "../route";

const post = (id: string, body: unknown) =>
  POST(
    new Request(`http://test/api/admin/orgs/${id}/credits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const KEY = "idem-12345678";
const okBody = (delta: number) => ({
  delta,
  reason_code: "support_goodwill",
  idempotency_key: KEY,
});

beforeEach(() => {
  requireStaffMock.mockReset().mockResolvedValue({ id: "staff-1", staff_role: "superadmin" });
  logStaffActionMock.mockReset().mockResolvedValue(undefined);
  sqlMock.mockReset().mockResolvedValue([{ id: "org-1" }]);
  walletIdForMock.mockReset().mockResolvedValue("wallet-1");
  adminAdjustMock.mockReset().mockResolvedValue({ applied: true, balanceAfter: 20 });
});

describe("POST /api/admin/orgs/[id]/credits", () => {
  it("grants credits and returns the new balance", async () => {
    const res = await post("org-1", okBody(20));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { ok: true, balance_after: 20, applied: true },
    });
    expect(adminAdjustMock).toHaveBeenCalledWith(
      "wallet-1",
      20,
      expect.objectContaining({ createdBy: "staff-1", idempotencyKey: KEY }),
    );
    expect(logStaffActionMock).toHaveBeenCalledWith(
      "staff-1",
      "credit_adjust",
      "org",
      "org-1",
      expect.objectContaining({ delta: 20, reason_code: "support_goodwill", wallet_id: "wallet-1" }),
    );
  });

  it("builds the stored reason from reason_code + optional note", async () => {
    await post("org-1", { delta: 5, reason_code: "promo", note: "launch week", idempotency_key: KEY });
    const opts = adminAdjustMock.mock.calls[0]![2] as { reason: string };
    expect(opts.reason).toContain("promo");
    expect(opts.reason).toContain("launch week");
  });

  it("rejects a non-staff caller before touching the DB or the wallet", async () => {
    requireStaffMock.mockRejectedValueOnce(new AuthError("Staff access required"));
    const res = await post("org-1", okBody(20));
    expect(res.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(adminAdjustMock).not.toHaveBeenCalled();
  });

  it("404s on an unknown org before adjusting", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await post("org-missing", okBody(20));
    expect(res.status).toBe(404);
    expect(adminAdjustMock).not.toHaveBeenCalled();
  });

  describe("RBAC threshold (§2)", () => {
    it("403s a support grant over the 50-credit cap, without adjusting", async () => {
      requireStaffMock.mockResolvedValue({ id: "sup", staff_role: "support" });
      const res = await post("org-1", okBody(51));
      expect(res.status).toBe(403);
      expect(adminAdjustMock).not.toHaveBeenCalled();
    });

    it("403s a support deduct beyond the cap by magnitude", async () => {
      requireStaffMock.mockResolvedValue({ id: "sup", staff_role: "support" });
      const res = await post("org-1", okBody(-51));
      expect(res.status).toBe(403);
      expect(adminAdjustMock).not.toHaveBeenCalled();
    });

    it("allows a support adjustment at or under the cap", async () => {
      requireStaffMock.mockResolvedValue({ id: "sup", staff_role: "support" });
      const res = await post("org-1", okBody(50));
      expect(res.status).toBe(200);
      expect(adminAdjustMock).toHaveBeenCalled();
    });

    it("allows a superadmin a large grant", async () => {
      requireStaffMock.mockResolvedValue({ id: "root", staff_role: "superadmin" });
      const res = await post("org-1", okBody(5000));
      expect(res.status).toBe(200);
      expect(adminAdjustMock).toHaveBeenCalled();
    });
  });

  it("maps an insufficient-balance deduct to 422", async () => {
    const { InsufficientBalanceError } = await import("@/lib/credits");
    adminAdjustMock.mockRejectedValueOnce(new InsufficientBalanceError("out of credits"));
    const res = await post("org-1", okBody(-20));
    expect(res.status).toBe(422);
  });

  describe("schema", () => {
    it("400s a zero delta", async () => {
      const res = await post("org-1", okBody(0));
      expect(res.status).toBe(400);
      expect(adminAdjustMock).not.toHaveBeenCalled();
    });

    it("400s an unknown reason_code", async () => {
      const res = await post("org-1", { delta: 5, reason_code: "nope", idempotency_key: KEY });
      expect(res.status).toBe(400);
    });

    it("400s a too-short idempotency_key", async () => {
      const res = await post("org-1", { delta: 5, reason_code: "promo", idempotency_key: "short" });
      expect(res.status).toBe(400);
    });

    it("400s an unknown field (strict)", async () => {
      const res = await post("org-1", { ...okBody(5), extra: "nope" });
      expect(res.status).toBe(400);
    });
  });
});
