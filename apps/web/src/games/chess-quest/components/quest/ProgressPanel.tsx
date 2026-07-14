"use client";

// Progress panel — streak, stars, track bars, a 14-day activity strip and a
// per-game stars table. Port of js/app.js renderProgressPanel (357–441).
import { HUNTS, MATE1, MATE2 } from "../../content/puzzles";
import { useCopy } from "../../lib/copy";
import { last14Days } from "../../lib/last14";
import { useProgress } from "../../lib/progress";
import { Modal } from "./Modal";

function todayISO() {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span aria-label={`${n} of 3 stars`} className="text-amber-500">
      {"★".repeat(n)}
      <span className="text-slate-300">{"☆".repeat(3 - n)}</span>
    </span>
  );
}

function TrackBar({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span>
          {done} / {total}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-purple-100">
        <div className="h-full rounded-full bg-purple-500" style={{ width: `${(done / total) * 100}%` }} />
      </div>
    </div>
  );
}

export function ProgressPanel({ onClose, onPrint }: { onClose(): void; onPrint(): void }) {
  const progress = useProgress();
  const { t, isStory } = useCopy();
  const name = progress.getName() || "This player";
  const t1 = ["fork", "pin", "skewer", "disco"].reduce((s, p) => s + progress.tacticCount(p), 0);
  const t2 = ["fork2", "pin2", "skewer2", "disco2"].reduce((s, p) => s + progress.tacticCount(p), 0);
  const puzzlesTotal =
    progress.solvedCount() + progress.solved2Count() + progress.huntCount() + t1 + t2;
  const streak = progress.streak();
  const days = last14Days(progress.activityDates(), todayISO());

  const rows: [string, string, string][] = [
    [
      "Square Race",
      "squareRace",
      progress.getBest("squareRace") ? `best: ${progress.getBest("squareRace")} squares` : "",
    ],
    ["Coin Hop", "coinHop", ""],
    ["Rook Maze", "rookMaze", ""],
    ["Pawn Wars", "pawnWars", ""],
    ["Mate in 1", "mateInOne", `${progress.solvedCount()} / ${MATE1.length} puzzles`],
    ["Mate in 2", "mateInTwo", `${progress.solved2Count()} / ${MATE2.length} puzzles`],
    ["Piece Detective", "hangingHunt", `${progress.huntCount()} / ${HUNTS.length} cases`],
    ["Trick Shots", "tacticTrainer", `${t1} / 13 tricks`],
    ["Trick Shots — Master", "tacticTrainer2", `${t2} / 12 tricks`],
  ];

  const tile = (num: React.ReactNode, label: string) => (
    <div className="flex flex-col items-center rounded-xl border border-slate-200 bg-slate-50 p-3">
      <span className="text-xl font-bold text-purple-950">{num}</span>
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );

  return (
    <Modal title="Progress" onClose={onClose}>
      <p className="text-xs text-slate-500">
        {name} · {isStory() ? "Story" : "Classic"} mode
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tile(streak, t("day streak 🔥", "day streak"))}
        {tile(`⭐ ${progress.totalStars()}`, "total stars")}
        {tile(puzzlesTotal, "puzzles solved")}
        {tile(progress.activityDates().length, "days played")}
      </div>

      <h3 className="mk-display mt-5 font-bold text-purple-950">Quest tracks</h3>
      <div className="mt-2 flex flex-col gap-2">
        <TrackBar label="Track 1 · First Steps" done={progress.trackDone(1)} total={24} />
        <TrackBar label="Track 2 · Rising Player" done={progress.trackDone(2)} total={24} />
      </div>

      <h3 className="mk-display mt-5 font-bold text-purple-950">Last 14 days</h3>
      <div
        role="img"
        aria-label={`Played on ${days.filter((d) => d.on).length} of the last 14 days`}
        className="mt-2 flex justify-between gap-1"
      >
        {days.map((d) => (
          <span key={d.iso} title={`${d.iso}${d.on ? " — played" : ""}`} className="flex flex-col items-center gap-1">
            <span
              className={`h-4 w-4 rounded-full ${d.on ? "bg-emerald-500" : "bg-slate-200"}`}
            />
            <span className="text-[10px] text-slate-400">{d.wd}</span>
          </span>
        ))}
      </div>

      <h3 className="mk-display mt-5 font-bold text-purple-950">Games</h3>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {rows.map(([label, id, detail]) => (
            <tr key={id} className="border-t border-slate-100">
              <td className="py-1.5 text-slate-700">{label}</td>
              <td className="py-1.5">
                <Stars n={progress.gameStars(id)} />
              </td>
              <td className="py-1.5 text-right text-xs text-slate-400">{detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-5">
        <button type="button" className="btn btn-primary" onClick={onPrint}>
          🖨 Print certificate
        </button>
      </div>
    </Modal>
  );
}
