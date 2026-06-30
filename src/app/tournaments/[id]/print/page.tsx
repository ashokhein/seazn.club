import { notFound } from "next/navigation";
import { loadBundle } from "@/lib/tournament";
import { computeStandings } from "@/lib/standings";
import { roundWindow, fmtTime, playerName } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

export default async function PrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const bundle = await loadBundle(id);
  if (!bundle) notFound();
  const { tournament: t, players, rounds, matches } = bundle;
  const standings = computeStandings(players, rounds, matches, {
    points_win: t.points_win,
    points_draw: t.points_draw,
    points_loss: t.points_loss,
    use_progress_score: t.use_progress_score,
  });

  const sortedRounds = [...rounds].sort((a, b) => a.round_number - b.round_number);
  const matchesByRound = (rid: string) =>
    matches.filter((m) => m.round_id === rid).sort((a, b) => a.board_number - b.board_number);
  const name = (pid: string | null) => playerName(players, pid);

  return (
    <main className="mx-auto max-w-3xl bg-white p-8 text-slate-900 print:p-0">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t.name}</h1>
          <p className="text-sm text-slate-600">
            {t.sport} · {t.category}
            {t.starts_at &&
              ` · ${new Date(t.starts_at).toLocaleString([], {
                dateStyle: "medium",
                timeStyle: "short",
              })}`}
          </p>
        </div>
        <PrintButton />
      </div>

      <section className="mb-6">
        <h2 className="mb-2 border-b border-slate-300 pb-1 text-lg font-semibold">
          Standings
        </h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="py-1">#</th>
              <th>Name</th>
              <th className="text-right">P</th>
              <th className="text-right">W/D/L</th>
              <th className="text-right">Pts</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((s) => (
              <tr key={s.player.id} className="border-t border-slate-200">
                <td className="py-1">{s.rank}</td>
                <td>
                  <span className="flex items-center gap-2">
                    {s.player.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={s.player.image_url}
                        alt=""
                        className="h-5 w-5 rounded-full object-cover"
                      />
                    )}
                    {s.player.name}
                  </span>
                </td>
                <td className="text-right">{s.played}</td>
                <td className="text-right">
                  {s.wins}/{s.draws}/{s.losses}
                </td>
                <td className="text-right font-semibold">{s.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2 className="mb-2 border-b border-slate-300 pb-1 text-lg font-semibold">
          Schedule &amp; results
        </h2>
        {sortedRounds.map((r) => {
          const w = roundWindow(t.starts_at, t.round_minutes, r.round_number - 1);
          return (
            <div key={r.id} className="mb-4 break-inside-avoid">
              <h3 className="font-medium">
                {r.name}
                {w && (
                  <span className="ml-2 text-sm text-slate-500">
                    {fmtTime(w.start)}–{fmtTime(w.end)}
                  </span>
                )}
              </h3>
              <ul className="mt-1 text-sm">
                {matchesByRound(r.id).map((m) => (
                  <li key={m.id} className="flex justify-between border-b border-slate-100 py-1">
                    <span>
                      {name(m.player1_id)}
                      {m.is_bye ? " (bye)" : ` vs ${name(m.player2_id)}`}
                    </span>
                    <span className="text-slate-600">
                      {m.is_bye
                        ? "advances"
                        : m.is_draw
                          ? "draw"
                          : m.winner_id
                            ? `${name(m.winner_id)} won${
                                m.player1_score != null && m.player2_score != null
                                  ? ` (${m.player1_score}-${m.player2_score})`
                                  : ""
                              }`
                            : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>
    </main>
  );
}
