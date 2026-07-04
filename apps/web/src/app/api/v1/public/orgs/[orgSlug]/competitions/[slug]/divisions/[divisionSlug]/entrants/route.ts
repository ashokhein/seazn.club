import { v1, reply } from "@/server/api-v1/http";
import { publicEntrants, publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";

type Ctx = { params: Promise<{ orgSlug: string; slug: string; divisionSlug: string }> };

/** Consent-filtered entrant list (initials unless public_name, doc 07 note 4). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, slug, divisionSlug } = await params;
    const data = await publicEntrants(orgSlug, slug, divisionSlug);
    return reply(200, data, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
