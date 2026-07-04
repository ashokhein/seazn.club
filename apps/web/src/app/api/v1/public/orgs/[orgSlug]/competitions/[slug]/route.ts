import { v1, reply } from "@/server/api-v1/http";
import { publicCompetition, publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

/** Public competition landing: description + divisions (no auth, doc 08 §3). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, slug } = await params;
    const data = await publicCompetition(orgSlug, slug);
    return reply(200, data, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
