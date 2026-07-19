"use client";

// SPEC-1 Discipline panel (division console, sibling of the entrants panel):
// the pending queue the organiser confirms/waives, the active bans with match
// pips, served/waived history, and a manual "Record suspension" form over the
// division squad. Card glyphs lead every row; pending rows wear an amber rail
// and a "Pending review" eyebrow. .card light chrome to match the entrants
// panel it sits beside.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import type { Suspension } from "@/server/usecases/discipline";
import { CardGlyph, toneForSource } from "./card-glyph";
import { ServePips } from "./serve-pips";
import { ReportDrawer, type MatchReport } from "@/components/officials/report-drawer";

export function DisciplinePanel({
  divisionId,
  initial,
  squad,
  canEdit,
}: {
  divisionId: string;
  initial: Suspension[];
  squad: { person_id: string; full_name: string }[];
  canEdit: boolean;
}) {
  const msg = useMsg();
  const router = useRouter();
  const [items, setItems] = useState<Suspension[]>(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = items.filter((s) => s.status === "pending");
  const active = items.filter((s) => s.status === "active");
  const history = items.filter((s) => s.status === "served" || s.status === "waived");

  function replace(next: Suspension) {
    setItems((prev) => prev.map((s) => (s.id === next.id ? next : s)));
  }

  async function decide(id: string, kind: "confirm" | "waive") {
    setBusyId(id);
    setError(null);
    try {
      const next = await apiV1<Suspension>(`/api/v1/suspensions/${id}`, {
        method: "PATCH",
        json: { kind },
      });
      replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiV1Error ? err.message : msg("disc.panel.failed"));
    } finally {
      setBusyId(null);
    }
  }

  async function record(input: { person_id: string; matches_total: number; reason: string }) {
    setBusyId("record");
    setError(null);
    try {
      const created = await apiV1<Suspension>(`/api/v1/divisions/${divisionId}/suspensions`, {
        method: "POST",
        json: input,
      });
      setItems((prev) => [created, ...prev]);
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof ApiV1Error ? err.message : msg("disc.panel.failed"));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="space-y-6" data-testid="discipline-panel">
      <h2 className="app-display text-lg font-semibold text-slate-900">{msg("disc.panel.title")}</h2>
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {/* Pending queue */}
      <div className="space-y-2">
        <p className="app-eyebrow text-amber-600">{msg("disc.panel.pending")}</p>
        {pending.length === 0 ? (
          <p className="text-xs text-slate-400">{msg("disc.panel.pendingEmpty")}</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((s) => (
              <li
                key={s.id}
                className="card flex flex-col gap-3 border-l-4 border-l-amber-400 p-4 sm:flex-row sm:items-center sm:justify-between"
                data-testid="pending-row"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <CardGlyph tone={toneForSource(s.source)} className="mt-0.5" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{s.personName}</p>
                    <p className="text-xs text-slate-500">
                      {s.reason} · {msg("disc.panel.matches")} {s.matchesTotal}
                      {s.entrantName ? ` · ${s.entrantName}` : ""}
                    </p>
                    {s.triggerVoided && (
                      <span className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                        {msg("disc.panel.triggerVoided")}
                      </span>
                    )}
                    {s.source === "report" && s.fixtureId && (
                      <ReportSourceTag fixtureId={s.fixtureId} personId={s.personId} />
                    )}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busyId === s.id}
                      onClick={() => decide(s.id, "confirm")}
                      className="btn btn-primary min-h-[44px] text-sm"
                    >
                      {msg("disc.panel.confirm")}
                    </button>
                    <button
                      type="button"
                      disabled={busyId === s.id}
                      onClick={() => decide(s.id, "waive")}
                      className="btn btn-ghost min-h-[44px] text-sm"
                    >
                      {msg("disc.panel.waive")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Active bans */}
      <div className="space-y-2">
        <p className="app-eyebrow text-slate-400">{msg("disc.panel.active")}</p>
        {active.length === 0 ? (
          <p className="text-xs text-slate-400">{msg("disc.panel.activeEmpty")}</p>
        ) : (
          <ul className="space-y-2">
            {active.map((s) => (
              <li
                key={s.id}
                className="card flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
                data-testid="active-row"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <CardGlyph tone={toneForSource(s.source)} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">{s.personName}</p>
                    <p className="text-xs text-slate-500">
                      {s.reason}
                      {s.entrantName ? ` · ${s.entrantName}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <ServePips served={s.matchesServed} total={s.matchesTotal} />
                  {canEdit && (
                    <button
                      type="button"
                      disabled={busyId === s.id}
                      onClick={() => decide(s.id, "waive")}
                      className="inline-flex min-h-[44px] items-center text-xs text-slate-400 hover:text-red-500 hover:underline"
                    >
                      {msg("disc.panel.waive")}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Record suspension */}
      {canEdit && squad.length > 0 && <RecordForm squad={squad} onSubmit={record} busy={busyId === "record"} />}

      {/* History */}
      {history.length > 0 && (
        <details className="space-y-2">
          <summary className="app-eyebrow cursor-pointer text-slate-400 hover:text-slate-600">
            {msg("disc.panel.history")} ({history.length})
          </summary>
          <ul className="mt-2 space-y-2">
            {history.map((s) => (
              <li key={s.id} className="card flex items-center justify-between gap-3 p-3 opacity-80">
                <div className="flex min-w-0 items-center gap-3">
                  <CardGlyph tone={toneForSource(s.source)} className="opacity-60" />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-slate-700">{s.personName}</p>
                    <p className="text-xs text-slate-400">{s.reason}</p>
                  </div>
                </div>
                <span
                  className={`badge ${s.status === "served" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}
                >
                  {s.status === "served" ? msg("disc.panel.served") : msg("disc.panel.waived")}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/** SPEC-3 bridge tag: a suspension raised from a submitted match report wears a
 *  "From match report" chip + a link that fetches the fixture's reports and
 *  opens the read-only drawer (the report whose incidents name this person, or
 *  the first). Free read — reports have no gate. */
function ReportSourceTag({ fixtureId, personId }: { fixtureId: string; personId: string }) {
  const msg = useMsg();
  const [report, setReport] = useState<(MatchReport & { officialName: string }) | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function view() {
    if (report) {
      setOpen((v) => !v);
      return;
    }
    setBusy(true);
    try {
      const reports = await apiV1<(MatchReport & { officialName: string })[]>(
        `/api/v1/fixtures/${fixtureId}/reports`,
      );
      const match =
        reports.find((r) => r.incidents.some((i) => i.person_id === personId)) ?? reports[0] ?? null;
      setReport(match);
      setOpen(true);
    } catch {
      // Free read; a transient failure just leaves the drawer closed.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 space-y-2">
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">
          {msg("disc.panel.fromReport")}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void view()}
          className="inline-flex min-h-[44px] items-center text-[11px] font-medium text-purple-600 hover:underline"
        >
          {msg("disc.panel.viewReport")}
        </button>
      </span>
      {open && report && (
        <div className="rounded-lg border border-slate-200 p-3">
          <ReportDrawer report={report} officialName={report.officialName} />
        </div>
      )}
    </div>
  );
}

function RecordForm({
  squad,
  onSubmit,
  busy,
}: {
  squad: { person_id: string; full_name: string }[];
  onSubmit: (input: { person_id: string; matches_total: number; reason: string }) => Promise<boolean>;
  busy: boolean;
}) {
  const msg = useMsg();
  const [personId, setPersonId] = useState("");
  const [matches, setMatches] = useState(1);
  const [reason, setReason] = useState("");

  async function submit() {
    if (!personId || !reason.trim() || matches < 1) return;
    const ok = await onSubmit({ person_id: personId, matches_total: matches, reason: reason.trim() });
    if (ok) {
      setPersonId("");
      setMatches(1);
      setReason("");
    }
  }

  return (
    <div className="card space-y-3 p-4" data-testid="record-form">
      <p className="text-sm font-semibold text-slate-700">{msg("disc.panel.record")}</p>
      <p className="text-xs text-slate-400">{msg("disc.panel.recordHint")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block">
          <span className="label">{msg("disc.panel.person")}</span>
          <select
            value={personId}
            onChange={(e) => setPersonId(e.target.value)}
            className="input w-full"
            aria-label={msg("disc.panel.person")}
          >
            <option value="">{msg("disc.panel.selectPerson")}</option>
            {squad.map((p) => (
              <option key={p.person_id} value={p.person_id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">{msg("disc.panel.matches")}</span>
          <input
            type="number"
            min={1}
            max={20}
            value={matches}
            onChange={(e) => setMatches(Number(e.target.value))}
            className="input w-full"
            aria-label={msg("disc.panel.matches")}
          />
        </label>
      </div>
      <label className="block">
        <span className="label">{msg("disc.panel.reason")}</span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={msg("disc.panel.reasonPlaceholder")}
          className="input w-full"
          aria-label={msg("disc.panel.reason")}
        />
      </label>
      <button
        type="button"
        disabled={busy || !personId || !reason.trim()}
        onClick={submit}
        className="btn btn-primary min-h-[44px] text-sm"
      >
        {msg("disc.panel.recordCta")}
      </button>
    </div>
  );
}
