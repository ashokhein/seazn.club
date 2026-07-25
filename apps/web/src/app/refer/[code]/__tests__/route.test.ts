// /refer/<code> (#267 T2, SPEC-5 §2): always redirects to /start; a code
// that resolves also drops the "ref" cookie for consumeReferralCookie to
// pick up at org-creation time. A bad/expired code is graceful — no 404,
// no cookie, straight to /start.
import { it, expect, vi, beforeEach } from "vitest";

const resolveReferralCode = vi.fn(async (_code: string) => null as { orgId: string } | null);
vi.mock("@/lib/referral", () => ({
  REFERRAL_COOKIE: "ref",
  resolveReferralCode: (...a: [string]) => resolveReferralCode(...a),
}));

const get = async (code: string) => {
  const { GET } = await import("../route");
  const res = await GET(new Request(`http://t/refer/${code}`), { params: Promise.resolve({ code }) });
  return res;
};

beforeEach(() => resolveReferralCode.mockReset());

it("valid code → redirects to /start and sets the ref cookie", async () => {
  resolveReferralCode.mockResolvedValue({ orgId: "org-1" });
  const res = await get("VALIDCODE1");
  expect(res.status).toBe(307);
  expect(new URL(res.headers.get("location")!).pathname).toBe("/start");
  expect(res.cookies.get("ref")?.value).toBe("VALIDCODE1");
});

it("unknown code → redirects to /start, no cookie set", async () => {
  resolveReferralCode.mockResolvedValue(null);
  const res = await get("NOSUCHCODE");
  expect(res.status).toBe(307);
  expect(new URL(res.headers.get("location")!).pathname).toBe("/start");
  expect(res.cookies.get("ref")).toBeUndefined();
});
