"use client";

// SPEC-3 UI surface 3: the official's match-report form on the /me officiating
// lane (free portal principle, D5 — refs file from the car park, so it works
// one-handed on `.input`/`.label`/`.textarea` defaults). Draft autosaves on blur
// (PUT); submit confirms once and then the report is immutable, rendered
// read-only through the shared ReportBody with a submitted timestamp eyebrow.
// Body + squad are fetched lazily on open so the lane stays light.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { Zoned } from "@/components/client-time";
import { ReportBody, type IncidentKind, type MatchReport, type ReportIncident } from "./report-drawer";

const KINDS: IncidentKind[] = ["red_card", "misconduct", "injury", "other"];

interface SquadMember {
  person_id: string;
  full_name: string;
  entrant_id: string;
  entrant_name: string;
}

/** Draft incident being edited (note may be empty until the ref types it). */
interface DraftIncident {
  kind: IncidentKind;
  person_id: string;
  note: string;
}

function toDrafts(incidents: ReportIncident[]): DraftIncident[] {
  return incidents.map((i) => ({ kind: i.kind, person_id: i.person_id ?? "", note: i.note }));
}
function toIncidents(drafts: DraftIncident[]): ReportIncident[] {
  return drafts
    .filter((d) => d.note.trim())
    .map((d) => ({
      kind: d.kind,
      note: d.note.trim(),
      ...(d.person_id ? { person_id: d.person_id } : {}),
    }));
}

export function ReportForm({
  fixtureOfficialId,
  venueTz = "UTC",
  onClose,
}: {
  fixtureOfficialId: string;
  venueTz?: string;
  onClose?: () => void;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [report, setReport] = useState<MatchReport | null>(null);
  const [squad, setSquad] = useState<SquadMember[]>([]);
  const [body, setBody] = useState("");
  const [drafts, setDrafts] = useState<DraftIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [rep, sq] = await Promise.all([
          apiV1<MatchReport | null>(`/api/v1/me/officiating/${fixtureOfficialId}/report`),
          apiV1<SquadMember[]>(`/api/v1/me/officiating/${fixtureOfficialId}/squad`).catch(() => []),
        ]);
        if (!alive) return;
        setSquad(sq);
        if (rep) {
          setReport(rep);
          setBody(rep.body);
          setDrafts(toDrafts(rep.incidents));
        }
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : msg("report.failed"));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fixtureOfficialId, msg]);

  const submitted = report?.status === "submitted";
  const names = Object.fromEntries(squad.map((m) => [m.person_id, m.full_name]));

  async function save(nextBody = body, nextDrafts = drafts): Promise<void> {
    if (submitted) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await apiV1<MatchReport>(`/api/v1/me/officiating/${fixtureOfficialId}/report`, {
        method: "PUT",
        json: { body: nextBody, incidents: toIncidents(nextDrafts) },
      });
      setReport(saved);
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "REPORT_SUBMITTED") {
        // Immutable now — reflect the submitted state instead of erroring.
        router.refresh();
      } else {
        setError(err instanceof Error ? err.message : msg("report.failed"));
      }
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // Persist the latest edits first, then submit.
      await apiV1<MatchReport>(`/api/v1/me/officiating/${fixtureOfficialId}/report`, {
        method: "PUT",
        json: { body, incidents: toIncidents(drafts) },
      });
      const done = await apiV1<MatchReport>(
        `/api/v1/me/officiating/${fixtureOfficialId}/report/submit`,
        { method: "POST" },
      );
      setReport(done);
      setConfirming(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : msg("report.failed"));
    } finally {
      setBusy(false);
    }
  }

  function setDraft(i: number, patch: Partial<DraftIncident>) {
    setDrafts((prev) => prev.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));
  }
  function addDraft() {
    setDrafts((prev) => [...prev, { kind: "other", person_id: "", note: "" }]);
  }
  function removeDraft(i: number) {
    const next = drafts.filter((_, idx) => idx !== i);
    setDrafts(next);
    void save(body, next);
  }

  if (loading) {
    return <p className="card p-3 text-xs text-slate-400">{msg("report.loading")}</p>;
  }

  if (submitted && report) {
    return (
      <div className="card space-y-2 border-l-4 border-l-slate-300 p-4" data-testid="report-submitted">
        <p className="app-eyebrow !text-slate-400">
          {msg("report.submittedEyebrow")}
          {report.submittedAt && (
            <>
              {" · "}
              <Zoned value={report.submittedAt} tz={venueTz} mode="datetime" showZone you="subtitle" />
            </>
          )}
        </p>
        <ReportBody report={report} personNames={names} />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[44px] items-center text-xs font-medium text-purple-600 hover:underline"
          >
            {msg("report.close")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="card space-y-3 p-4" data-testid="report-form">
      <p className="text-sm font-semibold text-slate-800">{msg("report.title")}</p>
      <p className="text-xs text-slate-400">{msg("report.hint")}</p>

      <label className="block">
        <span className="label">{msg("report.body")}</span>
        <textarea
          className="textarea w-full"
          rows={4}
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => void save()}
          placeholder={msg("report.bodyPlaceholder")}
          aria-label={msg("report.body")}
        />
      </label>

      <div className="space-y-2">
        <p className="label">{msg("report.incidents")}</p>
        {drafts.length === 0 && <p className="text-xs text-slate-400">{msg("report.noIncidents")}</p>}
        <ul className="space-y-2">
          {drafts.map((d, i) => (
            <li key={i} className="rounded-lg border border-slate-200 p-2.5" data-testid="incident-row">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="label">{msg("report.kind")}</span>
                  <select
                    className="input w-full"
                    value={d.kind}
                    disabled={busy}
                    aria-label={msg("report.kind")}
                    onChange={(e) => {
                      setDraft(i, { kind: e.target.value as IncidentKind });
                      void save(body, drafts.map((x, idx) => (idx === i ? { ...x, kind: e.target.value as IncidentKind } : x)));
                    }}
                  >
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {msg(`report.kind.${k}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="label">{msg("report.person")}</span>
                  <select
                    className="input w-full"
                    value={d.person_id}
                    disabled={busy || squad.length === 0}
                    aria-label={msg("report.person")}
                    onChange={(e) => {
                      setDraft(i, { person_id: e.target.value });
                      void save(body, drafts.map((x, idx) => (idx === i ? { ...x, person_id: e.target.value } : x)));
                    }}
                  >
                    <option value="">{msg("report.personNone")}</option>
                    {squad.map((m) => (
                      <option key={m.person_id} value={m.person_id}>
                        {m.full_name} · {m.entrant_name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="mt-2 block">
                <span className="label">{msg("report.note")}</span>
                <input
                  className="input w-full"
                  value={d.note}
                  disabled={busy}
                  onChange={(e) => setDraft(i, { note: e.target.value })}
                  onBlur={() => void save()}
                  placeholder={msg("report.notePlaceholder")}
                  aria-label={msg("report.note")}
                />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => removeDraft(i)}
                className="mt-1.5 inline-flex min-h-[44px] items-center text-xs text-slate-400 hover:text-red-500 hover:underline"
              >
                {msg("report.removeIncident")}
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={busy}
          onClick={addDraft}
          className="btn btn-ghost min-h-[44px] text-sm"
        >
          {msg("report.addIncident")}
        </button>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      {confirming ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-3">
          <p className="text-xs text-amber-800">{msg("report.confirmSubmit")}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="btn btn-primary min-h-[44px] text-sm"
          >
            {msg("report.confirmSubmitCta")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(false)}
            className="btn btn-ghost min-h-[44px] text-sm"
          >
            {msg("report.cancel")}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirming(true)}
            className="btn btn-primary min-h-[44px] text-sm"
          >
            {msg("report.submit")}
          </button>
          {report && <span className="text-xs text-slate-400">{msg("report.draftSaved")}</span>}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-[44px] items-center text-xs font-medium text-slate-500 hover:underline"
            >
              {msg("report.close")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
