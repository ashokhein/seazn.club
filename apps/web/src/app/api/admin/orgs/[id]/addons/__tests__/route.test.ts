// POST/DELETE /api/admin/orgs/[id]/addons — the SPEC-3 §1 row 3 staff add-on
// grant/revoke route. requireSuperadmin, org-exists, grantAddon and revokeAddon
// are mocked so this asserts the ROUTE's own contract: the superadmin gate
// (support cannot comp add-ons), 404 on an unknown org, the strict zod schemas,
// and the reason (code + note) fold. The grant/revoke DB behaviour (granted
// row, freeze-not-delete, idempotency) is covered in
// server/usecases/__tests__/admin-addons.test.ts. Mirrors the sibling credits
// route test idiom.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { AuthError } from "@/lib/errors";
import type { StaffRole } from "@/lib/admin";

const requireSuperadminMock =
  vi.fn<() => Promise<{ id: string; staff_role: StaffRole | null }>>();
vi.mock("@/lib/admin", () => ({
  requireSuperadmin: () => requireSuperadminMock(),
}));

const sqlMock = vi.fn<(...args: unknown[]) => Promise<{ id: string }[]>>();
vi.mock("@/lib/db", () => ({
  sql: (...args: unknown[]) => sqlMock(...args),
}));

const grantAddonMock =
  vi.fn<(...args: unknown[]) => Promise<{ id: string; applied: boolean }>>();
const revokeAddonMock = vi.fn<(...args: unknown[]) => Promise<{ revoked: boolean }>>();
vi.mock("@/server/usecases/admin-addons", () => ({
  grantAddon: (...args: unknown[]) => grantAddonMock(...args),
  revokeAddon: (...args: unknown[]) => revokeAddonMock(...args),
}));

import { POST, DELETE } from "../route";

const ORG = randomUUID();
const ADDON = randomUUID();
const KEY = "idem-12345678";

const post = (id: string, body: unknown) =>
  POST(
    new Request(`http://test/api/admin/orgs/${id}/addons`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const del = (id: string, body: unknown) =>
  DELETE(
    new Request(`http://test/api/admin/orgs/${id}/addons`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

const grantBody = () => ({
  feature_key: "members.max",
  delta_each: 2,
  qty: 3,
  reason_code: "sales_comp",
  idempotency_key: KEY,
});

beforeEach(() => {
  requireSuperadminMock.mockReset().mockResolvedValue({ id: "root", staff_role: "superadmin" });
  sqlMock.mockReset().mockResolvedValue([{ id: ORG }]);
  grantAddonMock.mockReset().mockResolvedValue({ id: ADDON, applied: true });
  revokeAddonMock.mockReset().mockResolvedValue({ revoked: true });
});

describe("POST /api/admin/orgs/[id]/addons (grant)", () => {
  it("grants an add-on and returns the row id + applied", async () => {
    const res = await post(ORG, grantBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { ok: true, addon_id: ADDON, applied: true },
    });
    expect(grantAddonMock).toHaveBeenCalledWith(
      "root",
      ORG,
      expect.objectContaining({
        featureKey: "members.max",
        deltaEach: 2,
        qty: 3,
        targetOrgId: null,
        idempotencyKey: KEY,
      }),
    );
  });

  it("folds reason_code + note into the stored reason", async () => {
    await post(ORG, { ...grantBody(), note: "launch deal" });
    const opts = grantAddonMock.mock.calls[0]![2] as { reason: string };
    expect(opts.reason).toContain("sales_comp");
    expect(opts.reason).toContain("launch deal");
  });

  it("passes a set target_org_id through", async () => {
    await post(ORG, { ...grantBody(), target_org_id: ADDON });
    const opts = grantAddonMock.mock.calls[0]![2] as { targetOrgId: string | null };
    expect(opts.targetOrgId).toBe(ADDON);
  });

  it("refuses a non-superadmin before touching the DB (support cannot comp add-ons)", async () => {
    requireSuperadminMock.mockRejectedValueOnce(new AuthError("Superadmin access required"));
    const res = await post(ORG, grantBody());
    expect(res.status).toBe(401);
    expect(sqlMock).not.toHaveBeenCalled();
    expect(grantAddonMock).not.toHaveBeenCalled();
  });

  it("404s an unknown org before granting", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await post("nope", grantBody());
    expect(res.status).toBe(404);
    expect(grantAddonMock).not.toHaveBeenCalled();
  });

  describe("schema", () => {
    it("400s a blank feature_key", async () => {
      const res = await post(ORG, { ...grantBody(), feature_key: "" });
      expect(res.status).toBe(400);
      expect(grantAddonMock).not.toHaveBeenCalled();
    });
    it("400s a non-positive qty", async () => {
      const res = await post(ORG, { ...grantBody(), qty: 0 });
      expect(res.status).toBe(400);
    });
    it("400s a non-positive delta_each", async () => {
      const res = await post(ORG, { ...grantBody(), delta_each: -1 });
      expect(res.status).toBe(400);
    });
    it("400s a too-short idempotency_key", async () => {
      const res = await post(ORG, { ...grantBody(), idempotency_key: "short" });
      expect(res.status).toBe(400);
    });
    it("400s an unknown reason_code", async () => {
      const res = await post(ORG, { ...grantBody(), reason_code: "nope" });
      expect(res.status).toBe(400);
    });
    it("400s an unknown field (strict)", async () => {
      const res = await post(ORG, { ...grantBody(), extra: "x" });
      expect(res.status).toBe(400);
    });
  });
});

describe("DELETE /api/admin/orgs/[id]/addons (revoke)", () => {
  it("revokes an add-on and returns revoked", async () => {
    const res = await del(ORG, { addon_id: ADDON, reason_code: "bug_fix" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { ok: true, revoked: true } });
    expect(revokeAddonMock).toHaveBeenCalledWith("root", ORG, ADDON, expect.stringContaining("bug_fix"));
  });

  it("refuses a non-superadmin", async () => {
    requireSuperadminMock.mockRejectedValueOnce(new AuthError("Superadmin access required"));
    const res = await del(ORG, { addon_id: ADDON, reason_code: "bug_fix" });
    expect(res.status).toBe(401);
    expect(revokeAddonMock).not.toHaveBeenCalled();
  });

  it("400s a non-uuid addon_id", async () => {
    const res = await del(ORG, { addon_id: "not-a-uuid", reason_code: "bug_fix" });
    expect(res.status).toBe(400);
    expect(revokeAddonMock).not.toHaveBeenCalled();
  });
});
