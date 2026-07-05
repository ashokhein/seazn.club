import { v1, reply } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { getCurrentUser, getOrgRole } from "@/lib/auth";
import { publicRateLimit } from "@/server/usecases/public";
import { fixtureRealtimeEligible } from "@/server/public-site/data";
import { fixtureScope, scorerCovers } from "@/server/usecases/scorers";
import { mintPublicFixtureToken } from "@/lib/realtime";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Public realtime subscriber token for `fixture:{id}` (doc 09 §4). 403 unless
 * the fixture's org has the `realtime` entitlement — Community spectators use
 * the 15 s polling fallback. Enforced here (service layer), not in the UI.
 * Exception (doc 13 §6): the fixture's own officials — editors and covering
 * scorers — get realtime regardless of plan; they are producing the data.
 */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const eligible = (await fixtureRealtimeEligible(id)) || (await isFixtureOfficial(id));
    if (!eligible) throw new HttpError(403, "realtime not available for this competition");
    const token = await mintPublicFixtureToken(id);
    return reply(200, { token, channel: `fixture:${id}` });
  });
}

async function isFixtureOfficial(fixtureId: string): Promise<boolean> {
  const user = await getCurrentUser();
  if (!user) return false;
  const scope = await fixtureScope(fixtureId);
  if (!scope) return false;
  const role = await getOrgRole(scope.org_id, user.id);
  if (role === "owner" || role === "admin") return true;
  return role === "scorer" && (await scorerCovers(scope.org_id, user.id, scope));
}
