// GET/PUT /api/billing/group/allocation — the operator allocation console API
// (v17 SPEC-5 §1). The use case owns the DB gating (tested against real Postgres
// in server/usecases/__tests__/operator-allocation.test.ts); here the use case
// and auth are mocked, so what is asserted is purely the ROUTE contract: it
// passes the authenticated caller through, validates the PUT body strictly, and
// surfaces the use case's HttpError with the right status via the shared handler.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const caller = vi.hoisted(() => ({ id: "user-1" }));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: caller.id }) }));

const usecase = vi.hoisted(() => ({
  allocationConsole: vi.fn(),
  setOrgAllocation: vi.fn(),
}));
vi.mock("@/server/usecases/operator-allocation", () => ({
  allocationConsole: (...a: unknown[]) => usecase.allocationConsole(...a),
  setOrgAllocation: (...a: unknown[]) => usecase.setOrgAllocation(...a),
}));

import { HttpError } from "@/lib/errors";
import { GET, PUT } from "../route";

const putReq = (body: unknown) =>
  new Request("http://x/api/billing/group/allocation", {
    method: "PUT",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  caller.id = "user-1";
  usecase.allocationConsole.mockReset();
  usecase.setOrgAllocation.mockReset();
});

describe("GET /api/billing/group/allocation", () => {
  it("returns the console for the authenticated caller", async () => {
    const data = { walletId: "sub_1", poolBalance: 40, members: [] };
    usecase.allocationConsole.mockResolvedValue(data);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data });
    expect(usecase.allocationConsole).toHaveBeenCalledWith("user-1");
  });

  it("surfaces the payer-gate 403 from the use case", async () => {
    usecase.allocationConsole.mockRejectedValue(new HttpError(403, "not a payer"));
    const res = await GET();
    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
  });
});

describe("PUT /api/billing/group/allocation", () => {
  it("sets a member's cap and returns ok", async () => {
    usecase.setOrgAllocation.mockResolvedValue(undefined);
    const org = randomUUID();

    const res = await PUT(putReq({ org_id: org, monthly_cap: 25 }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(usecase.setOrgAllocation).toHaveBeenCalledWith("user-1", org, 25);
  });

  it("accepts monthly_cap: null (clear to unlimited)", async () => {
    usecase.setOrgAllocation.mockResolvedValue(undefined);
    const org = randomUUID();

    const res = await PUT(putReq({ org_id: org, monthly_cap: null }));
    expect(res.status).toBe(200);
    expect(usecase.setOrgAllocation).toHaveBeenCalledWith("user-1", org, null);
  });

  it("rejects a non-uuid org_id with 400, never calling the use case", async () => {
    const res = await PUT(putReq({ org_id: "not-a-uuid", monthly_cap: 5 }));
    expect(res.status).toBe(400);
    expect(usecase.setOrgAllocation).not.toHaveBeenCalled();
  });

  it("rejects a negative or fractional cap with 400", async () => {
    const org = randomUUID();
    expect((await PUT(putReq({ org_id: org, monthly_cap: -1 }))).status).toBe(400);
    expect((await PUT(putReq({ org_id: org, monthly_cap: 2.5 }))).status).toBe(400);
    expect(usecase.setOrgAllocation).not.toHaveBeenCalled();
  });

  it("surfaces a use-case 403 (org not in the caller's group)", async () => {
    usecase.setOrgAllocation.mockRejectedValue(new HttpError(403, "not the payer"));
    const org = randomUUID();
    const res = await PUT(putReq({ org_id: org, monthly_cap: 5 }));
    expect(res.status).toBe(403);
  });
});
