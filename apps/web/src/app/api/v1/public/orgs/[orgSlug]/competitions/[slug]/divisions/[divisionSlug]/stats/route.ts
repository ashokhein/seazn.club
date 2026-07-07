import { v1 } from "@/server/api-v1/http";
import { publicRateLimit } from "@/server/usecases/public";
import { publicDivisionStats } from "@/server/usecases/player-stats";

type Ctx = { params: Promise<{ orgSlug: string; slug: string; divisionSlug: string }> };

/** Consent-filtered public leaderboard (Jul3/07 §6): minors' names gated via
 *  public_person_name (doc 06 §4.7). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, slug, divisionSlug } = await params;
    return publicDivisionStats(orgSlug, slug, divisionSlug);
  });
}
