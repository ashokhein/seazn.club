import { v1, reply } from "@/server/api-v1/http";
import { publicStandings, publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";

type Ctx = { params: Promise<{ orgSlug: string; slug: string; divisionSlug: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, slug, divisionSlug } = await params;
    const data = await publicStandings(orgSlug, slug, divisionSlug);
    return reply(200, data, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
