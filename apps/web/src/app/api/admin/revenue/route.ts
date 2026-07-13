import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperadmin } from "@/lib/admin";
import { handler } from "@/lib/http";
import { platformRevenue, type PlatformRevenue } from "@/server/usecases/platform-revenue";

const DAY_MS = 86_400_000;

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD").optional(),
  format: z.enum(["csv"]).optional(),
}).strict();

/** Default = the last 12 calendar months including the current one, on
 *  whole-month UTC boundaries. A custom `to` day is inclusive, so the
 *  usecase's exclusive bound is the following midnight. */
function resolveRange(q: { from?: string; to?: string }): { from: Date; to: Date } {
  if (q.from || q.to) {
    const from = new Date(`${q.from ?? q.to}T00:00:00Z`);
    const to = new Date(new Date(`${q.to ?? q.from}T00:00:00Z`).getTime() + DAY_MS);
    return { from, to };
  }
  const now = new Date();
  const monthStart = (offset: number) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return { from: monthStart(-11), to: monthStart(1) };
}

const esc = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function csvResponse(result: PlatformRevenue, from: Date, to: Date): Response {
  const header = "month,org,org_slug,currency,gross_minor,refunded_minor,net_minor,fee_count";
  const lines = result.rows.map((r) =>
    [r.month, r.org, r.org_slug, r.currency, r.gross, r.refunded, r.net, r.count].map(esc).join(","),
  );
  const stamp = `${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}`;
  return new NextResponse([header, ...lines].join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="platform-revenue-${stamp}.csv"`,
    },
  });
}

/** GET /api/admin/revenue — platform application-fee rollups (superadmin).
 *  ?from=YYYY-MM-DD&to=YYYY-MM-DD (to inclusive), ?format=csv for export.
 *  Range >24 months and missing Stripe config reject in the usecase (422/503). */
export async function GET(req: Request) {
  return handler(async () => {
    await requireSuperadmin();
    const url = new URL(req.url);
    const q = querySchema.parse(Object.fromEntries(url.searchParams));
    const { from, to } = resolveRange(q);
    const result = await platformRevenue({ from, to });
    if (q.format === "csv") return csvResponse(result, from, to);
    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      ...result,
    };
  });
}
