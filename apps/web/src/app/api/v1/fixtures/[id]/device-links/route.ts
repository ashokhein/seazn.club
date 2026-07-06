import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { rateLimit } from "@/lib/rate-limit";
import { CreateDeviceLink } from "@/server/api-v1/schemas";
import { createDeviceLink, getActiveDeviceLink } from "@/server/usecases/device-links";

type Ctx = { params: Promise<{ id: string }> };

// Per-IP limit on the mint route (doc 08 §6 pattern; PROMPT-21 item 5).
const MINT_LIMIT = { max: 10, windowSeconds: 60 };

/**
 * Mint a day-of device link (doc 13 §7): editor session only, secret shown
 * once, prior active links for the fixture are revoked (one live device).
 * 402 `scoring.device_links` for Community orgs.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`dlmint:${ip}`, MINT_LIMIT);
    const body = await parseBody(req, CreateDeviceLink);
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return reply(201, await createDeviceLink(auth, id, body.label ?? null));
  });
}

/** The fixture's active link, if any (organiser console; never the secret). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "write");
    return getActiveDeviceLink(auth, id);
  });
}
