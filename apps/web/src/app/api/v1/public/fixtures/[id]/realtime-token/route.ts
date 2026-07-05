import { v1, reply } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { publicRateLimit } from "@/server/usecases/public";
import { fixtureRealtimeEligible } from "@/server/public-site/data";
import { mintPublicFixtureToken } from "@/lib/realtime";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Public realtime subscriber token for `fixture:{id}` (doc 09 §4). 403 unless
 * the fixture's org has the `realtime` entitlement — Community spectators use
 * the 15 s polling fallback. Enforced here (service layer), not in the UI.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const eligible = await fixtureRealtimeEligible(id);
    if (!eligible) throw new HttpError(403, "realtime not available for this competition");
    const token = await mintPublicFixtureToken(id);
    return reply(200, { token, channel: `fixture:${id}` });
  });
}
