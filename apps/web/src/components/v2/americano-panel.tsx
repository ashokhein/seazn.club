"use client";

// Americano / Mexicano console (Jul3/08 §3): rotation grid with inline score
// entry + a live personal-points leaderboard. Padel scoring is per-point, not
// win/loss — you enter each pair's points; the running total is who's winning
// the night. Courtside entry is the whole workflow, so scores go in-grid
// rather than through the separate fixture console.
import { useCallback, useEffect, useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

interface Team {
  entrant_id: string;
  label: string;
  score: number | null;
}
interface Match {
  fixture_id: string;
  court: number;
  status: string;
  team1: Team;
  team2: Team;
}
interface Round {
  round_no: number;
  matches: Match[];
}
interface Leader {
  person_id: string;
  name: string;
  points: number;
  games: number;
}
interface View {
  stage_id: string;
  mode: "americano" | "mexicano";
  rounds: Round[];
  leaderboard: Leader[];
}

export function AmericanoPanel({ stageId, canEdit }: { stageId: string; canEdit: boolean }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setView(await apiV1<View>(`/api/v1/stages/${stageId}/americano`));
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? "formats.advanced"));
      } else {
        setError(err instanceof Error ? err.message : "Failed to load");
      }
    }
  }, [stageId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  if (paywall) return <UpgradeGate feature={paywall} />;
  if (error) return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>;
  if (!view) return <p className="text-sm text-slate-500">Loading rotation…</p>;

  return (
    <div className="mb-6 space-y-4" aria-label="Americano rotation">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-slate-900">Rotation</h2>
        <span className="chip capitalize">{view.mode}</span>
        <span className="text-xs text-slate-400">rotating partners · personal points</span>
      </div>

      {view.leaderboard.length > 0 && (
        <section className="card p-4" aria-label="Personal points leaderboard">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">Personal points</h3>
          <table className="table">
            <thead>
              <tr>
                <th className="px-3 py-1.5 text-left">#</th>
                <th className="px-3 py-1.5 text-left">Player</th>
                <th className="px-3 py-1.5 text-right">Pts</th>
                <th className="px-3 py-1.5 text-right">Games</th>
              </tr>
            </thead>
            <tbody>
              {view.leaderboard.map((l, i) => (
                <tr key={l.person_id} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 text-sm text-slate-400">{i + 1}</td>
                  <td className="px-3 py-1.5 text-sm font-medium text-slate-900">{l.name}</td>
                  <td className="px-3 py-1.5 text-right text-sm font-semibold text-purple-700">{l.points}</td>
                  <td className="px-3 py-1.5 text-right text-sm text-slate-500">{l.games}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {view.rounds.map((round) => (
          <section key={round.round_no} className="card p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-700">Round {round.round_no}</h3>
            <ul className="space-y-3">
              {round.matches.map((m) => (
                <MatchRow
                  key={m.fixture_id}
                  match={m}
                  canEdit={canEdit}
                  saving={savingId === m.fixture_id}
                  onSave={async (s1, s2) => {
                    setError(null);
                    setSavingId(m.fixture_id);
                    try {
                      await scoreMatch(m.fixture_id, s1, s2);
                      await load();
                    } catch (err) {
                      setError(err instanceof Error ? err.message : "Save failed");
                    } finally {
                      setSavingId(null);
                    }
                  }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

// Post the score: start the fixture (idempotent-ish — skip if already past
// scheduled) then the generic.result. Uses the live seq so re-runs are safe.
async function scoreMatch(fixtureId: string, s1: number, s2: number): Promise<void> {
  const state = await apiV1<{ status: string; last_seq: number | null }>(
    `/api/v1/fixtures/${fixtureId}/state`,
  );
  let seq = state.last_seq ?? 0;
  if (state.status === "scheduled") {
    await apiV1(`/api/v1/fixtures/${fixtureId}/events`, {
      method: "POST",
      json: { expected_seq: seq, type: "core.start", payload: {} },
    });
    seq += 1;
  }
  await apiV1(`/api/v1/fixtures/${fixtureId}/events`, {
    method: "POST",
    json: { expected_seq: seq, type: "generic.result", payload: { p1Score: s1, p2Score: s2 } },
  });
}

function MatchRow({
  match,
  canEdit,
  saving,
  onSave,
}: {
  match: Match;
  canEdit: boolean;
  saving: boolean;
  onSave: (s1: number, s2: number) => void;
}) {
  const decided = match.status === "decided" || match.status === "finalized";
  const [s1, setS1] = useState(match.team1.score?.toString() ?? "");
  const [s2, setS2] = useState(match.team2.score?.toString() ?? "");

  return (
    <li className="rounded-md border border-slate-100 p-2">
      <div className="mb-1 flex items-center gap-2 text-xs text-slate-400">
        Court {match.court}
        {decided && <span className="text-emerald-600">✓ scored</span>}
      </div>
      <div className="flex items-center gap-2 text-sm">
        <span className="flex-1 font-medium text-slate-800">{match.team1.label}</span>
        {canEdit && !decided ? (
          <input
            aria-label={`${match.team1.label} score`}
            type="number"
            min={0}
            className="input w-14 px-2 py-1 text-right text-xs"
            value={s1}
            onChange={(e) => setS1(e.target.value)}
          />
        ) : (
          <span className="w-14 text-right font-semibold text-slate-700">{match.team1.score ?? "–"}</span>
        )}
        <span className="text-slate-300">·</span>
        {canEdit && !decided ? (
          <input
            aria-label={`${match.team2.label} score`}
            type="number"
            min={0}
            className="input w-14 px-2 py-1 text-xs"
            value={s2}
            onChange={(e) => setS2(e.target.value)}
          />
        ) : (
          <span className="w-14 font-semibold text-slate-700">{match.team2.score ?? "–"}</span>
        )}
        <span className="flex-1 font-medium text-slate-800">{match.team2.label}</span>
      </div>
      {canEdit && !decided && (
        <div className="mt-2 text-right">
          <button
            type="button"
            className="btn btn-primary px-3 py-1 text-xs"
            disabled={saving || s1 === "" || s2 === ""}
            onClick={() => onSave(Number(s1), Number(s2))}
          >
            {saving ? "Saving…" : "Save score"}
          </button>
        </div>
      )}
    </li>
  );
}
