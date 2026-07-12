import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";

// Peer endpoint for multi-machine ISR coherence (lib/peer-revalidate). Applies
// tags LOCALLY only — it never re-broadcasts, so fan-out cannot loop. Guarded
// by the same CRON_SECRET the GHA cron endpoints use.
const Body = z.object({
  tags: z.array(z.string().min(1).max(200)).min(1).max(20),
  mode: z.enum(["swr", "expire"]),
});

function secretOk(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!secretOk(req.headers.get("x-cron-secret"))) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });
  const { tags, mode } = parsed.data;
  for (const tag of tags) {
    // Same Next 16 semantics as server/public-site/revalidate.ts: 'max' =
    // stale-while-revalidate for scoring pages; expire:0 = read-your-writes
    // for org chrome edits.
    try {
      if (mode === "expire") revalidateTag(tag, { expire: 0 });
      else revalidateTag(tag, "max");
    } catch {
      // outside a Next request scope (tests, scripts) — nothing to invalidate
    }
  }
  return NextResponse.json({ ok: true, applied: tags.length });
}
