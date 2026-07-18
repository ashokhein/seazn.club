import { v1, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { requireFeature } from "@/lib/entitlements";
import { sql } from "@/lib/db";
import { readAuditLedger } from "@/server/usecases/fixtures";
import { signAuditHead } from "@/lib/audit-sign";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/fixtures/{id}/audit — the full per-match activity trail
 *  (PROMPT-63): the append-only score_events stream with its V226 hash chain,
 *  the DB verifier's verdict, and an Ed25519 signature over the head hash for
 *  independent, offline verification (keys at /.well-known/seazn-audit-keys).
 *  Pro `scoring.audit_export` (an Event Pass on the competition also unlocks).
 *  In-play fixtures export too — the signature pins the head at issued_at. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "read");
    const [comp] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f
      join divisions d on d.id = f.division_id
      where f.id = ${id}`;
    await requireFeature(auth.orgId, "scoring.audit_export", comp?.competition_id);
    const ledger = await readAuditLedger(auth, id);
    const issuedAt = new Date().toISOString();
    return reply(200, {
      ...ledger,
      signature:
        ledger.head_hash !== null ? signAuditHead(id, ledger.head_hash, issuedAt) : null,
    });
  });
}
