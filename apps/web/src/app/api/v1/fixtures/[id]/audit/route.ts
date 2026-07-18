import { NextResponse } from "next/server";
import { v1, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { requireFeature } from "@/lib/entitlements";
import { sql } from "@/lib/db";
import { readAuditLedger } from "@/server/usecases/fixtures";
import { auditLedgerDoc } from "@/server/usecases/exports";
import { docModelToPdf } from "@/server/doc-render";
import { signAuditHead } from "@/lib/audit-sign";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/v1/fixtures/{id}/audit — the full per-match activity trail
 *  (PROMPT-63): the append-only score_events stream with its V226 hash chain,
 *  the DB verifier's verdict, and an Ed25519 signature over the head hash for
 *  independent, offline verification (keys at /.well-known/seazn-audit-keys).
 *  Pro `scoring.audit_export` (an Event Pass on the competition also unlocks).
 *  `?format=pdf` returns the human-readable signed trail — served from this
 *  per-fixture route (deliberate deviation from the division-scoped
 *  exports/[kind] family). In-play fixtures export too: the signature pins
 *  the head at issued_at. Raw-file response mirrors the exports route: the
 *  v1 envelope only wraps errors. */
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture", id, "read");
    const [comp] = await sql<{ competition_id: string }[]>`
      select d.competition_id from fixtures f
      join divisions d on d.id = f.division_id
      where f.id = ${id}`;
    await requireFeature(auth.orgId, "scoring.audit_export", comp?.competition_id);
    const ledger = await readAuditLedger(auth, id);
    const issuedAt = new Date().toISOString();
    const signature =
      ledger.head_hash !== null ? signAuditHead(id, ledger.head_hash, issuedAt) : null;

    const format = new URL(req.url).searchParams.get("format") ?? "json";
    if (format === "pdf") {
      const model = await auditLedgerDoc(
        auth,
        id,
        ledger,
        signature !== null ? { key_id: signature.key_id, issued_at: signature.issued_at } : null,
        { printedAt: issuedAt },
      );
      const bytes = await docModelToPdf(model);
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="audit-${ledger.fixture.fixture_no ?? id}.pdf"`,
        },
      });
    }
    return v1(async () => reply(200, { ...ledger, signature }));
  } catch (err) {
    return v1(async () => {
      throw err;
    });
  }
}
