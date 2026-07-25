import { NextResponse } from "next/server";
import { REFERRAL_COOKIE, resolveReferralCode } from "@/lib/referral";

/**
 * Land a shared referral link (SPEC-5 §2). Always redirects to `/start` — a
 * bad/expired code just starts signup with no cookie, never a 404/throw — but
 * a code that resolves also drops the `ref` cookie, which `consumeReferralCookie`
 * reads + consumes at org creation (`createOrgForUser` via its three callers)
 * to stamp `referred_by_org_id`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const res = NextResponse.redirect(new URL("/start", req.url));

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
