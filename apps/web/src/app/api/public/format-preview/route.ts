import { z } from "zod";
import { handler } from "@/lib/http";
import { rateLimit, type RateLimitConfig } from "@/lib/rate-limit";
import {
  MARKETING_FORMATS,
  marketingPreview,
  type MarketingFormat,
} from "@/lib/marketing/format-preview";

/** Public engine demo for the home configurator (design/v3/12 §4.4).
 *  Pure computation over placeholder entrants — no DB, no session. */
const PREVIEW_LIMIT: RateLimitConfig = { max: 30, windowSeconds: 60 };

const schema = z
  .object({
    format: z.enum(MARKETING_FORMATS),
    entrants: z.number().int().min(4).max(16),
  })
  .strict();

// Deterministic per (format, entrants) — cache for the process lifetime.
const cache = new Map<string, { phases: ReturnType<typeof marketingPreview> }>();

export async function POST(req: Request) {
  return handler(async () => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    await rateLimit(`format-preview:${ip}`, PREVIEW_LIMIT);

    const { format, entrants } = schema.parse(await req.json());
    const key = `${format}:${entrants}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = { phases: marketingPreview(format as MarketingFormat, entrants) };
      cache.set(key, hit);
    }
    return hit;
  });
}
