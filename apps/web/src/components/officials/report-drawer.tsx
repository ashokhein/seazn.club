"use client";

// SPEC-3: the read-only match-report renderer. `ReportBody` draws the body +
// incident rows (each led by the SPEC-1 card glyph for red_card, a plain kind
// chip otherwise) and is shared by the console `ReportDrawer` and the official's
// own submitted (read-only) state in report-form. Night panel, measure-limited
// body, timestamp eyebrow — no green success theatrics (D-direction).
import { CardGlyph } from "@/components/discipline/card-glyph";
import { useMsg } from "@/components/i18n/dict-provider";
import { Zoned } from "@/components/client-time";

export type IncidentKind = "red_card" | "misconduct" | "injury" | "other";
export interface ReportIncident {
  kind: IncidentKind;
  person_id?: string;
  entrant_id?: string;
  note: string;
}
export interface MatchReport {
  id: string;
  fixtureOfficialId: string;
  status: "draft" | "submitted";
  body: string;
  incidents: ReportIncident[];
  submittedAt: string | null;
}

/** Read-only body + incident rows. `personNames` optionally resolves an
 *  incident's person_id → a display name (the official's own view has the squad;
 *  the console drawer leans on the note). */
export function ReportBody({
  report,
  personNames,
}: {
  report: MatchReport;
  personNames?: Record<string, string>;
}) {
  const msg = useMsg();
  return (
    <div className="space-y-3">
      {report.body.trim() ? (
        <p className="max-w-prose whitespace-pre-wrap text-sm text-slate-700">{report.body}</p>
      ) : (
        <p className="text-xs italic text-slate-400">{msg("report.noBody")}</p>
      )}
      {report.incidents.length > 0 && (
        <ul className="space-y-2">
          {report.incidents.map((inc, i) => (
            <li key={i} className="flex items-start gap-2 rounded-lg bg-slate-50 p-2.5">
              {inc.kind === "red_card" ? (
                <CardGlyph tone="red" className="mt-0.5" />
              ) : (
                <span className="mt-0.5 inline-block h-4 w-3 shrink-0 rounded-[2px] bg-slate-300" aria-hidden />
              )}
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {msg(`report.kind.${inc.kind}`)}
                  {inc.person_id && personNames?.[inc.person_id] && (
                    <span className="ml-1.5 font-medium normal-case tracking-normal text-slate-700">
                      {personNames[inc.person_id]}
                    </span>
                  )}
                </p>
                <p className="text-sm text-slate-700">{inc.note}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Console drawer for a submitted report — official name + submitted timestamp
 *  eyebrow over the shared read-only body. */
export function ReportDrawer({
  report,
  officialName,
  venueTz = "UTC",
  personNames,
}: {
  report: MatchReport;
  officialName: string;
  venueTz?: string;
  personNames?: Record<string, string>;
}) {
  const msg = useMsg();
  return (
    <div className="space-y-3" data-testid="report-drawer">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800">
          {msg("report.byOfficial", { name: officialName })}
        </p>
        {report.submittedAt && (
          <p className="app-eyebrow !text-slate-400">
            <Zoned value={report.submittedAt} tz={venueTz} mode="datetime" showZone you="subtitle" />
          </p>
        )}
      </div>
      <ReportBody report={report} personNames={personNames} />
    </div>
  );
}
