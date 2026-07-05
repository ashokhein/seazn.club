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

export function StagesPanel({ stages, fixtures, entrantNames, canEdit }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [paywallFeature, setPaywallFeature] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // stage id in flight
  const [notice, setNotice] = useState<string | null>(null);

  async function act(stageId: string, action: "generate" | "complete") {
    setError(null);
    setPaywallFeature(null);
    setNotice(null);
    setBusy(stageId);
    try {
      if (action === "generate") {
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
        const out = await apiV1<{ completed: boolean }>(
          `/api/v1/stages/${stageId}/complete`,
          { method: "POST", json: {} },
        );
        setNotice(
          out.completed
            ? "Stage completed — next stage seeded from the final table."
            : "Stage is not ready to complete (undecided fixtures remain).",
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

      {stages.map((stage) => {
        const stageFixtures = fixtures.filter((f) => f.stage_id === stage.id);
        const rounds = [...new Set(stageFixtures.map((f) => f.round_no))].sort((a, b) => a - b);
        return (
          <section key={stage.id} className="card overflow-hidden">
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
            </header>

            {stageFixtures.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-400">
                No fixtures yet{canEdit ? " — generate them when entrants are registered." : "."}
              </p>
            ) : (
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
        );
      })}
    </div>
  );
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

  async function saveSchedule() {
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixtures/${fixture.id}`, {
        method: "PATCH",
        json: {
          scheduled_at: when ? new Date(when).toISOString() : null,
          venue: venue.trim() || null,
          court_label: court.trim() || null,
        },
      });
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

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
        <span className="text-xs text-slate-400">
          {fixture.scheduled_at
            ? new Date(fixture.scheduled_at).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })
            : "unscheduled"}
          {fixture.venue ? ` · ${fixture.venue}` : ""}
          {fixture.court_label ? ` · ${fixture.court_label}` : ""}
        </span>
        <span className={`badge ${FIXTURE_STATUS_STYLE[fixture.status] ?? ""}`}>
          {fixture.status.replace("_", " ")}
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className="text-xs text-purple-600 hover:underline"
          >
            {editing ? "close" : "schedule"}
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
