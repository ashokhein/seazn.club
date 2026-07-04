import { NextResponse } from "next/server";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";

// The contract, served from the code that implements it (doc 08 §5). The
// document is deterministic — build once per process.
let doc: Record<string, unknown> | null = null;

export async function GET() {
  doc = doc ?? buildOpenApiDocument();
  return NextResponse.json(doc, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
