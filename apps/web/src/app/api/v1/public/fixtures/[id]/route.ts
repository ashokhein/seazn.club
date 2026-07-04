import { v1, reply } from "@/server/api-v1/http";
import { publicFixture, publicRateLimit, PUBLIC_CACHE_CONTROL } from "@/server/usecases/public";

type Ctx = { params: Promise<{ id: string }> };

/** Live public fixture summary (doc 08 §3). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { id } = await params;
    const data = await publicFixture(id);
    return reply(200, data, { "Cache-Control": PUBLIC_CACHE_CONTROL });
  });
}
