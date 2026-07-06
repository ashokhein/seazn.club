import { v1, reply } from "@/server/api-v1/http";
import { HttpError } from "@/lib/errors";
import { discoveryList, publicRateLimit } from "@/server/usecases/public";

// Doc 15 §4: anonymous homepage traffic — cached hard (Redis 30 s inside the
// use-case + CDN s-maxage=60 here), zero queries beyond public_discovery_v.
const DISCOVERY_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=300";

/** Opaque cursor = base64url offset (rank ordering is not keyset-able). */
function decodeOffset(raw: string | null): number {
  if (!raw) return 0;
  const n = Number(Buffer.from(raw, "base64url").toString("utf8"));
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, "Invalid cursor");
  return n;
}

/** GET /api/v1/public/discovery?sport=&country=&status=&q=&cursor=&limit= */
export async function GET(req: Request) {
  return v1(async () => {
    await publicRateLimit(req);
    const p = new URL(req.url).searchParams;
    const status = p.get("status");
    if (status && status !== "live" && status !== "upcoming") {
      throw new HttpError(400, "status must be 'live' or 'upcoming'");
    }
    const rawLimit = p.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new HttpError(400, "Invalid limit");
    }
    const { items, nextOffset } = await discoveryList({
      sport: p.get("sport") ?? undefined,
      country: p.get("country") ?? undefined,
      status: (status as "live" | "upcoming" | null) ?? undefined,
      q: p.get("q") ?? undefined,
      offset: decodeOffset(p.get("cursor")),
      limit,
    });
    const nextCursor =
      nextOffset === null ? null : Buffer.from(String(nextOffset), "utf8").toString("base64url");
    return reply(
      200,
      { items, nextCursor },
      { "Cache-Control": DISCOVERY_CACHE_CONTROL },
    );
  });
}
