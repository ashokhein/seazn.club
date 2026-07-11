import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";

// The contract, served from the code that implements it (doc 08 §5). The
// documents are deterministic — build once per process. `?published=1`
// returns the curated developer spec (key-scoped surface + public tag,
// v3/08 §3) that /developers renders.
let fullDoc: Record<string, unknown> | null = null;
let publishedDoc: Record<string, unknown> | null = null;

export async function GET(req: Request) {
  const published = new URL(req.url).searchParams.get("published") === "1";
  let doc: Record<string, unknown>;
  if (published) {
    publishedDoc = publishedDoc ?? buildOpenApiDocument({ published: true });
    doc = publishedDoc;
  } else {
    fullDoc = fullDoc ?? buildOpenApiDocument();
    doc = fullDoc;
  }
  return NextResponse.json(doc, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
