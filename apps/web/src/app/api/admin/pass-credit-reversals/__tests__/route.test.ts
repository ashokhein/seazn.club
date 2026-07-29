// POST /api/admin/pass-credit-reversals — the staff resolution endpoint for a
// pass-credit redemption stuck on `reversal_undetermined_at` (#305, #286 phase
// 2). Mirrors the admin-route test idiom (api/admin/entitlements): the guard
// and the usecase are mocked so this asserts the ROUTE's contract only — who
// may record which decision, and that the decision reaches the usecase intact.
//
// The privilege split is the point. `clawed_back` RELEASES the group's lifetime
// pass-credit cap, so a wrong one is a second Event Pass credit handed out;
// `kept` frees nothing. Support staff may record the second, not the first.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError } from "@/lib/errors";

const requireStaffMock = vi.fn<() => Promise<{ id: string; staff_role: string | null }>>();
vi.mock("@/lib/admin", () => ({
  requireStaff: () => requireStaffMock(),
}));

const resolveMock = vi.fn<(...args: unknown[]) => Promise<{ resolved: boolean }>>();
const listMock = vi.fn<() => Promise<unknown[]>>();
vi.mock("@/server/usecases/pass-credit", () => ({
  resolveUndeterminedPassCreditReversal: (...args: unknown[]) => resolveMock(...args),
  listUndeterminedPassCreditReversals: () => listMock(),
}));

import { GET, POST } from "../route";

// A real v4 uuid: zod's .uuid() checks the version and variant nibbles, so a
// made-up "1111-2222-3333-4444" string 400s before the guard is ever reached.
const REDEMPTION = "11111111-2222-4333-8444-555555555555";

const post = (body: unknown) =>
  POST(
    new Request("http://test/api/admin/pass-credit-reversals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  requireStaffMock.mockReset().mockResolvedValue({ id: "staff-1", staff_role: "superadmin" });
  resolveMock.mockReset().mockResolvedValue({ resolved: true });
  listMock.mockReset().mockResolvedValue([]);
});

describe("POST /api/admin/pass-credit-reversals", () => {
  it("records a superadmin claw-back with the amount actually removed in Stripe", async () => {
    const res = await post({
      redemption_id: REDEMPTION,
      resolution: "clawed_back",
      reversed_minor: 2500,
      reason: "removed by hand, cbtxn_x",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { resolved: true } });
    expect(resolveMock).toHaveBeenCalledWith("staff-1", REDEMPTION, {
      resolution: "clawed_back",
      reversedMinor: 2500,
      reason: "removed by hand, cbtxn_x",
    });
  });

  it("lets support staff record 'kept' — it frees nothing", async () => {
    requireStaffMock.mockResolvedValue({ id: "staff-2", staff_role: "support" });

    const res = await post({
      redemption_id: REDEMPTION,
      resolution: "kept",
      reason: "customer keeps it",
    });

    expect(res.status).toBe(200);
    expect(resolveMock).toHaveBeenCalledWith("staff-2", REDEMPTION, {
      resolution: "kept",
      reversedMinor: undefined,
      reason: "customer keeps it",
    });
  });

  it("refuses a claw-back from support staff — that one releases the cap", async () => {
    requireStaffMock.mockResolvedValue({ id: "staff-2", staff_role: "support" });

    const res = await post({
      redemption_id: REDEMPTION,
      resolution: "clawed_back",
      reversed_minor: 2500,
      reason: "nope",
    });

    expect(res.status).toBe(403);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("rejects a non-staff caller before any write", async () => {
    requireStaffMock.mockRejectedValue(new AuthError("Staff access required"));

    const res = await post({ redemption_id: REDEMPTION, resolution: "kept", reason: "x" });

    expect(res.status).toBe(401);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("400s a malformed body before any write", async () => {
    const res = await post({ redemption_id: "not-a-uuid", resolution: "maybe", reason: "" });

    expect(res.status).toBe(400);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it("passes a usecase refusal through with its own status", async () => {
    resolveMock.mockRejectedValue(
      Object.assign(new Error("nothing to resolve"), { status: 409, name: "HttpError" }),
    );
    const res = await post({ redemption_id: REDEMPTION, resolution: "kept", reason: "x" });
    // Not a 200 dressed up as success — the operator must see the refusal.
    expect(res.status).not.toBe(200);
  });
});

describe("GET /api/admin/pass-credit-reversals", () => {
  it("returns the worklist to staff", async () => {
    listMock.mockResolvedValue([{ id: REDEMPTION, status: "open" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { rows: [{ id: REDEMPTION, status: "open" }] },
    });
  });

  it("rejects a non-staff caller", async () => {
    requireStaffMock.mockRejectedValue(new AuthError("Staff access required"));
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });
});
