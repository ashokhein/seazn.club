// Americano / Mexicano rotation grid (Jul3/08 §3): partners rotate each round.
// A round-by-round board — court, both pairs, and the score once decided — so
// the rotating-partner structure is legible instead of a flat fixture list.
// Pure presentational (server-rendered); no client state.

interface Fixture {
  id: string;
  stage_id: string;
  round_no: number | null;
  seq_in_round: number | null;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  status: string;
}

export function AmericanoPanel({
  stageName,
  mode,
  fixtures,
  entrantNames,
}: {
  stageName: string;
  mode: "americano" | "mexicano";
  fixtures: Fixture[];
  entrantNames: Record<string, string>;
}) {
  const name = (id: string | null) => (id ? entrantNames[id] ?? "TBD" : "TBD");
  const rounds = [...new Set(fixtures.map((f) => f.round_no ?? 0))].sort((a, b) => a - b);

  return (
    <div className="mb-6 space-y-4" aria-label="Americano rotation">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold text-slate-900">{stageName}</h2>
        <span className="chip capitalize">{mode}</span>
        <span className="text-xs text-slate-400">rotating partners · personal points</span>
      </div>

      {rounds.length === 0 && (
        <p className="text-sm text-slate-500">
          No rounds generated yet — generate the stage to draw the rotation.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rounds.map((round) => {
          const inRound = fixtures
            .filter((f) => (f.round_no ?? 0) === round)
            .sort((a, b) => (a.seq_in_round ?? 0) - (b.seq_in_round ?? 0));
          return (
            <section key={round} className="card p-4">
              <h3 className="mb-3 text-sm font-semibold text-slate-700">Round {round}</h3>
              <ul className="space-y-2">
                {inRound.map((f) => {
                  const decided = f.status === "decided" || f.status === "finalized";
                  return (
                    <li
                      key={f.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-slate-100 px-2 py-1.5 text-sm"
                    >
                      <span className="text-xs text-slate-400">Court {f.seq_in_round ?? 1}</span>
                      <span className="flex-1 text-right font-medium text-slate-800">
                        {name(f.home_entrant_id)}
                      </span>
                      <span className={decided ? "text-emerald-600" : "text-slate-400"}>
                        {decided ? "✓" : "vs"}
                      </span>
                      <span className="flex-1 font-medium text-slate-800">
                        {name(f.away_entrant_id)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
