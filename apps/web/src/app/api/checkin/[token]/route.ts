import { handler } from "@/lib/http";
import { requireUser } from "@/lib/auth";
import { verifyCheckinToken } from "@/server/usecases/checkin-token";
import { checkInToFixture } from "@/server/usecases/me";

type Ctx = { params: Promise<{ token: string }> };

/** QR self-check-in (PROMPT-53): stamp presence for the caller's claimed
 *  person on the fixture. No claimed person → needs_claim (the page shows
 *  the claim-first interstitial, never an error). */
export async function POST(_req: Request, { params }: Ctx) {
  return handler(async () => {
    const user = await requireUser();
    const { token } = await params;
    const fixtureId = await verifyCheckinToken(token);
    const row = await checkInToFixture(user.id, fixtureId);
    if (!row) return { needs_claim: true as const };
    return { checked_in: true as const, status: row.status, checked_in_at: row.checked_in_at };
  });
}
