import { NextResponse } from "next/server";
import { REFERRAL_COOKIE, resolveReferralCode } from "@/lib/referral";
import { baseUrl } from "@/lib/oauth";

/**
 * Land a shared referral link (SPEC-5 §2). Always redirects to `/start` — a
 * bad/expired code just starts signup with no cookie, never a 404/throw — but
 * a code that resolves also drops the `ref` cookie, which `consumeReferralCookie`
 * reads + consumes at org creation (`createOrgForUser` via its three callers)
 * to stamp `referred_by_org_id`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  // Redirect against the external base URL, not req.url — behind Fly's proxy
  // req.url is the internal binding (http://0.0.0.0:3000), which would send a
  // real browser to an unreachable address. This is the one externally-clicked
  // URL in the referral feature, so getting the public host right matters.
  const res = NextResponse.redirect(new URL("/start", baseUrl(req)));

  const ref = await resolveReferralCode(code);
  if (!ref) return res;

  res.cookies.set(REFERRAL_COOKIE, code, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
