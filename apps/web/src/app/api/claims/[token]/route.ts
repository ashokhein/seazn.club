import { handler } from "@/lib/http";
import { resolveClaimToken } from "@/server/usecases/person-claims";

type Ctx = { params: Promise<{ token: string }> };

/** Claim status view (PROMPT-53): the token IS the auth — mirrors
 *  /api/invites. Distinct error codes (CLAIM_INVALID/REVOKED/EXPIRED/CLAIMED)
 *  drive the /claim page's dead-end states. */
export async function GET(_req: Request, { params }: Ctx) {
  return handler(async () => {
    const { token } = await params;
    const claim = await resolveClaimToken(token);
    return {
      person_name: claim.person_name,
      org_name: claim.org_name,
      email: claim.email,
    };
  });
}
