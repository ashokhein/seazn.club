import { v1, reply } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { assertUuid } from "@/server/api-v1/auth";
import { rateLimit } from "@/lib/rate-limit";
import { mintMyScoreLink } from "@/server/usecases/me-officiating";

type Ctx = { params: Promise<{ id: string }> };

// Same per-IP budget as the organiser mint route — it's the same mint.
const MINT_LIMIT = { max: 10, windowSeconds: 60 };

/** "Score this match" (PROMPT-57): mint the fixture's day-of device link for
 *  an assigned official. Reuses the device-link mint — one live device per
 *  fixture, secret shown once, Pro `scoring.device_links` gate (402). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "fixture");
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`dlmint:${ip}`, MINT_LIMIT);
    const user = await requireUser();
    return reply(201, await mintMyScoreLink(user.id, id));
  });
}
