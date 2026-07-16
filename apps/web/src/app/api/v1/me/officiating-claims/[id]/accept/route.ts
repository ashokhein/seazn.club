import { v1, reply } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { acceptMyOfficiatingClaim } from "@/server/usecases/me-officiating";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Accept a pending officiating invite by id (v11.1 "Pending invites" card in
 * /me) — no token in the URL. Session only; the logged-in user's verified
 * email is checked against the invite's address (same strict match the
 * token-based /claim page enforces) inside the usecase, which also routes
 * through the SAME accept core the token flow uses. A claim id that isn't an
 * officiating claim, or that doesn't match the caller's email, 404/403s —
 * it never silently no-ops.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "officiating claim");
    const user = await requireUser();
    const accepted = await acceptMyOfficiatingClaim(id, user.id, user.email);
    return reply(200, accepted);
  });
}
