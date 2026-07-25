import { it, expect, vi, beforeEach } from "vitest";

const createOrgForUser = vi.fn(async (_u: string, name: string, _opts?: unknown) => ({ id: "org-9", name, slug: "s" }));
vi.mock("@/lib/auth", () => ({
  requireUser: vi.fn(async () => ({ id: "user-1" })),
  createOrgForUser: (...a: [string, string, unknown?]) => createOrgForUser(...a),
  setActiveOrgId: vi.fn(async () => {}),
  getUserOrgs: vi.fn(async () => []),
}));
const consumeReferralCookie = vi.fn(async (_userId: string) => null as string | null);
vi.mock("@/lib/referral", () => ({ consumeReferralCookie: (...a: [string]) => consumeReferralCookie(...a) }));
const attachOrgToGroup = vi.fn();
vi.mock("@/server/usecases/billing-groups", () => ({ attachOrgToGroup: (...a: unknown[]) => attachOrgToGroup(...a) }));

const post = async (body: unknown) => {
  const { POST } = await import("../route");
  const res = await POST(new Request("http://t/api/orgs", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as { data?: any; error?: unknown } };
};

beforeEach(() => {
  attachOrgToGroup.mockReset();
  createOrgForUser.mockClear();
  consumeReferralCookie.mockReset();
  consumeReferralCookie.mockResolvedValue(null);
});

it("no attachToGroupId → org created individual, attach never called", async () => {
  const r = await post({ name: "Solo" });
  expect(r.status).toBe(200);
  expect(attachOrgToGroup).not.toHaveBeenCalled();
  expect(r.json.data.attach).toBeUndefined();
});

it("eligible attachToGroupId → attach called, charged surfaced", async () => {
  attachOrgToGroup.mockResolvedValue({ subscription_id: "grp-1", quantity: 2, charged: true });
  const r = await post({ name: "Joiner", attachToGroupId: "11111111-1111-4111-8111-111111111111" });
  expect(attachOrgToGroup).toHaveBeenCalledWith({
    actorUserId: "user-1", orgId: "org-9", subscriptionId: "11111111-1111-4111-8111-111111111111",
  });
  expect(r.json.data.attach).toEqual({ ok: true, charged: true });
});

it("consumes the referral cookie and threads it into createOrgForUser (#267 T2)", async () => {
  consumeReferralCookie.mockResolvedValue("referrer-org-1");
  const r = await post({ name: "Referred" });
  expect(r.status).toBe(200);
  expect(consumeReferralCookie).toHaveBeenCalledWith("user-1");
  expect(createOrgForUser).toHaveBeenCalledWith("user-1", "Referred", { referredByOrgId: "referrer-org-1" });
});

it("attach failure → org still created standalone, reason surfaced (200)", async () => {
  const { HttpError } = await import("@/lib/errors");
  attachOrgToGroup.mockRejectedValue(new HttpError(409, "This billing group has an unpaid invoice. Settle it before adding another organisation."));
  const r = await post({ name: "Joiner", attachToGroupId: "11111111-1111-4111-8111-111111111111" });
  expect(r.status).toBe(200);
  expect(r.json.data.id).toBe("org-9");
  expect(r.json.data.attach).toEqual({ ok: false, reason: "This billing group has an unpaid invoice. Settle it before adding another organisation." });
});
