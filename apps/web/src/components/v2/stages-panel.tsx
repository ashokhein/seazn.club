"use client";

// Fixture console per stage (PROMPT-15 task 1): generate (idempotent),
// complete (guarded progression), inline scheduling; scoring lives on the
// fixture page.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

interface StageRow {
  id: string;
  seq: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
  qualification: Record<string, unknown> | null;
  status: string;
}
interface FixtureRow {
  id: string;
  stage_id: string;
  pool_id: string | null;
  round_no: number;
  seq_in_round: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  scheduled_at: string | null;
  venue: string | null;
  court_label: string | null;
  status: string;
  outcome: unknown;
}

interface Props {
  divisionId: string;
  stages: StageRow[];
  fixtures: FixtureRow[];
  entrantNames: Record<string, string>;
  canEdit: boolean;
}

const FIXTURE_STATUS_STYLE: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-600",
  in_play: "bg-amber-100 text-amber-700",
  decided: "bg-sky-100 text-sky-700",
  finalized: "bg-emerald-100 text-emerald-700",
  abandoned: "bg-slate-100 text-slate-400",
  forfeited: "bg-red-50 text-red-500",
  cancelled: "bg-slate-100 text-slate-400",
};

export function StagesPanel({ divisionId, stages, fixtures, entrantNames, canEdit }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // stage id in flight
  const [notice, setNotice] = useState<string | null>(null);

  async function act(stageId: string, action: "generate" | "complete" | "delete") {
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setBusy(stageId);
    try {
      if (action === "delete") {
        await apiV1(`/api/v1/stages/${stageId}`, { method: "DELETE" });
        setNotice("Stage deleted.");
      } else if (action === "generate") {
        const out = await apiV1<{ created: number; existing: number }>(
          `/api/v1/stages/${stageId}/generate`,
          { method: "POST", json: {} },
        );
        setNotice(
          out.created > 0
            ? `Generated ${out.created} fixture(s) (${out.existing} already existed).`
            : "Nothing new to generate — fixtures are up to date.",
        );
      } else {
        const out = await apiV1<{
          completed: boolean;
          qualified?: { entrants: string[] };
          next_stage_fixtures?: number;
          division_completed?: boolean;
        }>(`/api/v1/stages/${stageId}/complete`, { method: "POST", json: {} });
        setNotice(
          !out.completed
            ? "Stage is not ready to complete (undecided fixtures remain)."
            : out.division_completed
              ? "Stage completed — that was the last stage, the division is finished. 🏆"
              : out.next_stage_fixtures !== undefined
                ? `Stage completed — top ${out.qualified?.entrants.length ?? ""} advance; ${out.next_stage_fixtures} fixture(s) generated for the next stage.`
                : "Stage completed.",
        );
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywallFeature(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(null);
    }
  }

  if (stages.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        This division has no stages yet — recreate it with a format, or define
        stages via the API.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {notice && (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      )}
      {paywallFeature && <UpgradeGate feature={paywallFeature} />}
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
      )}

      {/* Active work first: completed stages sink to the bottom, so once the
          league wraps up the semis/final card is what the organiser lands on. */}
      {[...stages]
        .sort(
          (a, b) =>
            (a.status === "complete" ? 1 : 0) - (b.status === "complete" ? 1 : 0) ||
            a.seq - b.seq,
        )
        .map((stage) => {
        const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
        const rounds = [...new Set(stageFixtures.map((f) => f.round_no))].sort((a, b) => a - b);
        // Mirrors the server guard: last stage only, nothing played yet.
        const deletable =
          stage.seq === Math.max(...stages.map((s) => s.seq)) &&
          !stageFixtures.some((f) => ["in_play", "decided", "finalized"].includes(f.status));
        const maxRound = rounds[rounds.length - 1] ?? 0;
        // Bracket stages: one card per named round (Quarter-finals, Semi-finals,
        // Final / Rung N) instead of one long card with anonymous round breaks.
        const splitRounds = BRACKET_KINDS.has(stage.kind) && rounds.length > 0;
        return (
          <div key={stage.id} className="space-y-6">
          <section className="card overflow-hidden">
            <header className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-800">
                {stage.seq}. {stage.name}
              </h3>
              <span className="chip">{stage.kind}</span>
              <span className={`badge ${stageStatusStyle(stage.status)}`}>{stage.status}</span>
              <div className="flex-1" />
              {canEdit && stage.status !== "complete" && (
                <>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => act(stage.id, "generate")}
                    className="btn btn-ghost px-3 py-1.5 text-xs"
                  >
                    {busy === stage.id ? "Working…" : stage.kind === "swiss" ? "Pair next round" : "Generate fixtures"}
                  </button>
                  {stageFixtures.length > 0 && (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => act(stage.id, "complete")}
                      className="btn btn-primary px-3 py-1.5 text-xs"
                    >
                      Complete stage
                    </button>
                  )}
                </>
              )}
              {canEdit && deletable && stages.length > 1 && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete stage "${stage.name}"? Its ${stageFixtures.length} fixture(s) and pools are removed too. This cannot be undone.`,
                      )
                    ) {
                      void act(stage.id, "delete");
                    }
                  }}
                  className="btn btn-danger px-3 py-1.5 text-xs"
                >
                  Delete
                </button>
              )}
            </header>

            {stageFixtures.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-400">
                No fixtures yet{canEdit ? " — generate them when entrants are registered." : "."}
              </p>
            ) : splitRounds ? null : (
              <div className="divide-y divide-slate-100">
                {rounds.map((round) => (
                  <div key={round}>
                    <p className="bg-slate-50 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
                      Round {round}
                    </p>
                    <ul className="divide-y divide-slate-50">
                      {stageFixtures
                        .filter((f) => f.round_no === round)
                        .map((f) => (
                          <FixtureLine
                            key={f.id}
                            fixture={f}
                            entrantNames={entrantNames}
                            canEdit={canEdit}
                          />
                        ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          {splitRounds &&
            rounds.map((round) => (
              <section key={round} className="card overflow-hidden">
                <header className="border-b border-slate-100 bg-slate-50 px-4 py-2">
                  <h4 className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    {stage.name} — {bracketRoundLabel(stage.kind, round, maxRound)}
                  </h4>
                </header>
                <ul className="divide-y divide-slate-50">
                  {stageFixtures
                    .filter((f) => f.round_no === round)
                    .map((f) => (
                      <FixtureLine
                        key={f.id}
                        fixture={f}
                        entrantNames={entrantNames}
                        canEdit={canEdit}
                      />
                    ))}
                </ul>
              </section>
            ))}
          </div>
        );
      })}

      {canEdit && (
        <AddStageForm
          divisionId={divisionId}
          nextSeq={Math.max(0, ...stages.map((s) => s.seq)) + 1}
          onDone={(msg) => {
            setNotice(msg);
            router.refresh();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

// Follow-up stage (e.g. finals after a league). Qualification resolves from
// the previous stage's final table; if that stage is already complete the
// server seeds + generates on the spot.
const ADD_KINDS = [
  { key: "knockout", label: "Knockout" },
  { key: "stepladder", label: "Stepladder" },
  { key: "double_elim", label: "Double elimination" },
] as const;

function AddStageForm({
  divisionId,
  nextSeq,
  onDone,
  onError,
}: {
  divisionId: string;
  nextSeq: number;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Finals");
  const [kind, setKind] = useState<string>("knockout");
  const [topN, setTopN] = useState(4);
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    onError("");
    try {
      const stage = await apiV1<{ id: string }>(`/api/v1/divisions/${divisionId}/stages`, {
        method: "POST",
        json: {
          seq: nextSeq,
          kind,
          name: name.trim() || "Finals",
          config: {},
          qualification: { topN },
        },
      });
      try {
        const gen = await apiV1<{ created: number }>(`/api/v1/stages/${stage.id}/generate`, {
          method: "POST",
          json: {},
        });
        onDone(`Stage added — ${gen.created} fixture(s) generated for the top ${topN}.`);
      } catch (err) {
        // Previous stage not complete yet — the stage exists; completion will
        // seed + generate it.
        if (err instanceof ApiV1Error && err.code === "STAGE_NOT_READY") {
          onDone("Stage added — fixtures will generate when the previous stage completes.");
        } else {
          throw err;
        }
      }
      setOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost text-xs">
        + Add stage
      </button>
    );
  }

  return (
    <section className="card flex flex-wrap items-end gap-3 p-4">
      <label className="block">
        <span className="label">Stage name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          className="input w-40"
        />
      </label>
      <label className="block">
        <span className="label">Format</span>
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="select">
          {ADD_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="label">Qualify from table</span>
        <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} className="select">
          {[2, 3, 4, 6, 8].map((n) => (
            <option key={n} value={n}>
              Top {n}
            </option>
          ))}
        </select>
      </label>
      <button type="button" disabled={busy} onClick={add} className="btn btn-primary text-xs">
        {busy ? "Adding…" : "Add stage"}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost text-xs">
        Cancel
      </button>
    </section>
  );
}

const BRACKET_KINDS = new Set(["knockout", "double_elim", "stepladder"]);

// Named bracket rounds, by distance from the last round. Double-elim round
// numbers encode WB/LB/GF lanes, so plain "Round N" stays honest there.
function bracketRoundLabel(kind: string, roundNo: number, maxRound: number): string {
  if (kind === "stepladder") return `Rung ${roundNo}`;
  if (kind === "knockout") {
    const fromEnd = maxRound - roundNo;
    if (fromEnd === 0) return "Final";
    if (fromEnd === 1) return "Semi-finals";
    if (fromEnd === 2) return "Quarter-finals";
  }
  return `Round ${roundNo}`;
}

function stageStatusStyle(status: string): string {
  if (status === "active") return "bg-amber-100 text-amber-700";
  if (status === "complete") return "bg-emerald-100 text-emerald-700";
  return "bg-slate-100 text-slate-600";
}

function outcomeText(outcome: unknown, entrantNames: Record<string, string>): string | null {
  const o = outcome as { kind?: string; winner?: string } | null;
  if (!o?.kind) return null;
  switch (o.kind) {
    case "win":
    case "award":
      return `${entrantNames[o.winner ?? ""] ?? "?"} won${o.kind === "award" ? " (w/o)" : ""}`;
    case "draw":
      return "Draw";
    case "tie":
      return "Tie";
    case "no_result":
      return "No result";
    default:
      return null;
  }
}

function FixtureLine({
  fixture,
  entrantNames,
  canEdit,
}: {
  fixture: FixtureRow;
  entrantNames: Record<string, string>;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [when, setWhen] = useState(
    fixture.scheduled_at ? toLocalInput(fixture.scheduled_at) : "",
  );
  const [venue, setVenue] = useState(fixture.venue ?? "");
  const [court, setCourt] = useState(fixture.court_label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const home = fixture.home_entrant_id ? (entrantNames[fixture.home_entrant_id] ?? "?") : "TBD";
  const away = fixture.away_entrant_id ? (entrantNames[fixture.away_entrant_id] ?? "?") : "TBD";
  const decided = outcomeText(fixture.outcome, entrantNames);

  async function patchSchedule(json: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}`, { method: "PATCH", json });
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const saveSchedule = () =>
    patchSchedule({
      scheduled_at: when ? new Date(when).toISOString() : null,
      venue: venue.trim() || null,
      court_label: court.trim() || null,
    });

  const unschedule = () => {
    setWhen("");
    void patchSchedule({ scheduled_at: null });
  };

  // Play state only matters once a match is under way / done; before that a
  // plain "scheduled" DB status is noise next to the timetable chip.
  const played = ["in_play", "decided", "finalized", "cancelled"].includes(fixture.status);
  const timed = !!fixture.scheduled_at;

  return (
    <li className="px-4 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href={`/fixtures/${fixture.id}`}
          className="min-w-0 flex-1 text-sm text-slate-800 hover:text-purple-700"
        >
          <span className="font-medium">{home}</span>
          <span className="mx-1.5 text-slate-400">vs</span>
          <span className="font-medium">{away}</span>
          {decided && <span className="ml-2 text-xs text-slate-400">{decided}</span>}
        </Link>
        {/* Timetable chip — reflects whether the match has a kick-off time. */}
        <span
          className={`badge ${timed ? "bg-indigo-50 text-indigo-700 ring-1 ring-inset ring-indigo-200" : "bg-slate-100 text-slate-500"}`}
          title={timed ? "This match has a kick-off time" : "No kick-off time yet"}
        >
          {timed
            ? `Scheduled · ${new Date(fixture.scheduled_at as string).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
            : "Unscheduled"}
          {fixture.court_label ? ` · ${fixture.court_label}` : fixture.venue ? ` · ${fixture.venue}` : ""}
        </span>
        {/* Play state only once it's under way / done. */}
        {played && (
          <span className={`badge ${FIXTURE_STATUS_STYLE[fixture.status] ?? ""}`}>
            {fixture.status.replace("_", " ")}
          </span>
        )}
        {/* Scoring pad. */}
        <Link href={`/fixtures/${fixture.id}`} className="btn btn-ghost px-3 py-1 text-xs">
          {decided ? "View" : fixture.status === "in_play" ? "Score ●" : "Score"}
        </Link>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="btn btn-ghost px-3 py-1 text-xs"
          >
            {editing ? "Close" : timed ? "Edit time" : "Schedule"}
          </button>
        )}
        {canEdit && timed && !editing && (
          <button
            type="button"
            disabled={busy}
            onClick={unschedule}
            className="text-xs text-slate-500 hover:text-red-600 hover:underline"
          >
            Unschedule
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">When</span>
            <input
              type="datetime-local"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              className="input px-2 py-1 text-xs"
            />
          </label>
          <label className="block">
            <span className="label">Venue</span>
            <input
              value={venue}
              onChange={(e) => setVenue(e.target.value)}
              className="input w-40 px-2 py-1 text-xs"
            />
          </label>
          <label className="block">
            <span className="label">Court/pitch</span>
            <input
              value={court}
              onChange={(e) => setCourt(e.target.value)}
              className="input w-28 px-2 py-1 text-xs"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={saveSchedule}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {error && <span className="text-xs text-red-600">{error}</span>}
        </div>
      )}
    </li>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
