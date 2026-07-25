import { NextResponse } from "next/server";
import { requireOrgPage } from "@/server/page-auth";
import { walletIdFor } from "@/lib/credits";
import { creditHistory } from "@/server/usecases/credits-tab";

export const dynamic = "force-dynamic";

// Stable, machine-readable header (export headers are not localised — the CSV
// is a data file, matching the participants export convention). The `action`
// column carries the ledger action key; `model`/`competition` are placeholders
// until an ai_runs table lands (see credits-tab.ts).
const HEADER = ["date", "action", "model", "change", "competition", "org"];

function csvEscape(v: string | number): string {
  let s = String(v);
  // Formula-injection guard: a cell starting with = + - @ (or a leading tab/CR)
  // is executed as a formula in Excel/Sheets. The only user-controlled cell is an
  // org/competition name; neutralise it with a leading apostrophe.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/**
 * GET /o/[orgSlug]/settings/billing/credits.csv — the org's AI-credit run
 * history as CSV (SPEC-6 §A3 export). Session-authed via requireOrgPage (org
 * members only, non-members 404); reads the same wallet the Credits tab shows,
 * so a grouped org exports the shared pool it spends from.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const { org } = await requireOrgPage(orgSlug, { tail: "/settings/billing" });
  const walletId = await walletIdFor(org.id);
  const rows = await creditHistory(walletId, 1000);

  const lines = [
    HEADER,
    ...rows.map((r) => [
      r.dateIso,
      r.action,
      r.model ?? "",
      r.delta,
      r.competitionName ?? "",
      r.orgName ?? "",
    ]),
  ]
    .map((cells) => cells.map(csvEscape).join(","))
    .join("\r\n");

  return new NextResponse(lines, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ai-credits.csv"',
    },
  });
}
