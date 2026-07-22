import { createSession, setActiveOrgId } from "@/lib/auth";
import { handler } from "@/lib/http";
import { claimEmailInvite, inviteLanding } from "@/lib/invites";
import { stampTermsAcceptance } from "@/lib/legal";
import { rateLimit, AUTH_LIMIT } from "@/lib/rate-limit";
import { headers } from "next/headers";

/**
 * One-click accept for an email invite by someone who is NOT signed in. For a
 * NEW or UNVERIFIED invitee this mints a session — the invite token, emailed to
 * the address, proves inbox control, the same basis a magic link relies on — and
 * joins the org in a single POST. A VERIFIED account is never auto-logged-in (a
 * forwarded invite must not take over a real account): claimEmailInvite returns
 * needs_signin and the page falls back to normal sign-in.
 *
 * POST-only and rate-limited by design: a session-minting action must never ride
 * a GET, where an email link scanner or prefetch would consume it (and CSRF).
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  return handler(async () => {
    const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`invite-claim:${ip}`, AUTH_LIMIT);

    const { token } = await params;
    const result = await claimEmailInvite(token);
    if (result.needs_signin) return { needs_signin: true };

    await createSession(result.user_id);
    await setActiveOrgId(result.org_id);
    // The button sat under the "By continuing, you agree…" notice — record the
    // acceptance, same as the magic-link path (GDPR spec 2026-07-14).
    await stampTermsAcceptance(result.user_id);
    return {
      needs_signin: false,
      org_id: result.org_id,
      org_name: result.org_name,
      role: result.role,
      outcome: result.outcome,
      landing: inviteLanding(result.role, result.outcome),
    };
  });
}
