"use client";

// PROMPT-63 §4 — scoring-ledger integrity strip on the fixture console:
// chain-verified badge (mirrors /admin/audit's staff-log treatment) + the
// signed audit download (Pro `scoring.audit_export`). Hidden until the
// fixture has events (nothing to audit).
import { useMsg } from "@/components/i18n/dict-provider";

export function AuditStrip({
  fixtureId,
  verified,
  tamperedSeq,
  entitled,
}: {
  fixtureId: string;
  verified: boolean;
  tamperedSeq: number | null;
  entitled: boolean;
}) {
  const msg = useMsg();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="audit-strip">
      {verified ? (
        <span className="badge bg-emerald-100 text-emerald-700">{msg("audit.verified")}</span>
      ) : (
        <span className="badge bg-red-100 text-red-700">
          {msg("audit.tampered", { seq: tamperedSeq ?? 0 })}
        </span>
      )}
      {entitled ? (
        <a
          href={`/api/v1/fixtures/${fixtureId}/audit`}
          target="_blank"
          rel="noreferrer"
          className="btn btn-ghost px-2.5 py-1 text-xs"
        >
          {msg("audit.download")}
        </a>
      ) : (
        <span className="text-slate-400" title={msg("audit.proHint")}>
          {msg("audit.pro")}
        </span>
      )}
    </div>
  );
}
