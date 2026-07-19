// Staff ledger of AI Schedule Architect runs (v4). Reads the competition audit
// ledger cross-org on the superuser connection: 'schedule.ai_generated'
// (Phase A successes — the quota-counted rows), 'schedule.ai_officials_generated'
// (Phase B successes, incl. zero-token solver drafts) and 'schedule.ai_failed'
// (metered failures/timeouts, both phases — never quota-counted). Older rows
// predate the usage/cost payload and render as "—".
import { requireStaff } from "@/lib/admin";
import { listAiRuns, aiRunTotals, type AiRunRow } from "@/server/usecases/ai-runs-admin";

export const dynamic = "force-dynamic";

function money(v: number | null): string {
  return v === null ? "—" : `$${v.toFixed(4)}`;
}
function num(v: number | null): string {
  return v === null ? "—" : v.toLocaleString("en-GB");
}

const OUTCOME_CHIP: Record<string, string> = {
  ok: "bg-emerald-500/10 text-emerald-400",
  failed: "bg-red-500/10 text-red-400",
  timeout: "bg-amber-500/10 text-amber-400",
};

export default async function AdminAiRunsPage() {
  await requireStaff();
  const [rows, totals] = await Promise.all([listAiRuns(200), aiRunTotals(30)]);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">AI runs</h1>
        <p className="text-sm text-slate-400">
          Last 30 days: <span className="text-slate-200">{totals.runs}</span> runs ·{" "}
          <span className="text-slate-200">{num(totals.input_tokens)}</span> in /{" "}
          <span className="text-slate-200">{num(totals.output_tokens)}</span> out ·{" "}
          <span className="text-slate-200">{money(totals.cost_usd)}</span>
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">When</th>
              <th className="px-3 py-2">Org</th>
              <th className="px-3 py-2">Division</th>
              <th className="px-3 py-2">Phase</th>
              <th className="px-3 py-2">Mode</th>
              <th className="px-3 py-2">Model</th>
              <th className="px-3 py-2 text-right">In</th>
              <th className="px-3 py-2 text-right">Out</th>
              <th className="px-3 py-2 text-right">Repairs</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2">Outcome</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-6 text-center text-slate-500">
                  No AI runs recorded yet.
                </td>
              </tr>
            )}
            {rows.map((r: AiRunRow) => (
              <tr key={r.id} className="hover:bg-slate-900/50">
                <td className="whitespace-nowrap px-3 py-2 text-slate-400">
                  {new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")}
                </td>
                <td className="max-w-[12rem] truncate px-3 py-2">{r.org_name ?? "—"}</td>
                <td className="max-w-[12rem] truncate px-3 py-2">{r.division_name ?? "—"}</td>
                <td className="px-3 py-2">{r.phase}</td>
                <td className="px-3 py-2 text-slate-400">{r.mode ?? "—"}</td>
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-slate-400">
                  {r.model ?? "—"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">{num(r.input_tokens)}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{num(r.output_tokens)}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{num(r.repair_rounds)}</td>
                <td className="px-3 py-2 text-right font-mono text-xs">{money(r.cost_usd)}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${OUTCOME_CHIP[r.outcome] ?? "bg-slate-500/10 text-slate-400"}`}
                  >
                    {r.outcome}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
