"use client";

// SPEC-3 UI surface 2: the org official profile's marks summary — average
// scorebug badge, the total count, and the last five comments with their
// fixture labels. Org-private (D4): this is the organiser's own aggregate over
// its own marks, so it fetches the Pro `officials.marks` summary endpoint and
// reveals the upgrade gate on a 402. `MarksSummaryView` is the pure renderer
// (directly testable in the node-env workspace); `MarksSummaryBlock` is the
// fetch-on-open wrapper mounted from the directory row.
import { useEffect, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";
import { MarkBadge } from "./mark-badge";

export interface MarkSummaryData {
  average: number | null;
  count: number;
  recent: { mark: number; comment: string | null; fixtureLabel: string; createdAt: string }[];
}

/** Pure renderer for a loaded summary. */
export function MarksSummaryView({ summary }: { summary: MarkSummaryData }) {
  const msg = useMsg();
  if (summary.count === 0) {
    return <p className="text-xs text-slate-400">{msg("marks.summary.empty")}</p>;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {summary.average !== null && <MarkBadge average={summary.average} count={summary.count} />}
        <span className="text-xs text-slate-500">{msg("marks.summary.count", { count: summary.count })}</span>
      </div>
      {summary.recent.length > 0 && (
        <ul className="space-y-1.5">
          {summary.recent.map((r, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span className="app-display mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-slate-900 text-[11px] font-bold tabular-nums text-lime-400">
                {r.mark}
              </span>
              <span className="min-w-0">
                <span className="font-medium text-slate-700">{r.fixtureLabel}</span>
                {r.comment && <span className="text-slate-500"> — {r.comment}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MarksSummaryBlock({ officialId }: { officialId: string }) {
  const msg = useMsg();
  const [summary, setSummary] = useState<MarkSummaryData | null>(null);
  const [gated, setGated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await apiV1<MarkSummaryData>(`/api/v1/officials/${officialId}/marks-summary`);
        if (alive) setSummary(data);
      } catch (err) {
        if (!alive) return;
        if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setGated(true);
        else setError(err instanceof Error ? err.message : msg("marks.failed"));
      }
    })();
    return () => {
      alive = false;
    };
  }, [officialId, msg]);

  if (gated) return <UpgradeGate feature="officials.marks" compact />;
  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (!summary) return <p className="text-xs text-slate-400">{msg("marks.summary.loading")}</p>;
  return <MarksSummaryView summary={summary} />;
}
