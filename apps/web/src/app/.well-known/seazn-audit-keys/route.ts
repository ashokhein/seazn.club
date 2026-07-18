import { NextResponse } from "next/server";
import { auditPublicKeys } from "@/lib/audit-sign";

/** Public, unauthenticated Ed25519 verification keys for signed audit exports
 *  (PROMPT-63 §3) — anyone can verify a downloaded ledger without trusting
 *  the running app. Current + previous key during rotation. */
export async function GET() {
  return NextResponse.json(
    { keys: auditPublicKeys() },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
