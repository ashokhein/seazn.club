// /t/{slug} — v1 public tournament URLs, preserved as 301s onto the v2 public
// dashboard (PROMPT-15 task 3). The map is populated by
// scripts/migrate-v1-to-v2.ts (v1_slug_redirects); unknown slugs 404.
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  try {
    const [row] = await sql<{ target_path: string }[]>`
      select target_path from v1_slug_redirects where public_slug = ${slug} limit 1`;
    if (row) {
      return NextResponse.redirect(new URL(row.target_path, req.url), 301);
    }
  } catch {
    // table absent (fresh install that never had v1 data) → plain 404
  }
  return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
}
