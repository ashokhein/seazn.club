"use client";

// Chess Quest hub — pick a mini-game, play, come back. Games arrive here
// task by task through Phase C; C7 finalizes the full 8-game grid.
import "./chess-quest.css";
import { useState } from "react";
import { CopyProvider } from "./lib/copy";
import { ProgressProvider } from "./lib/progress";
import { SquareRace } from "./components/games/SquareRace";
import { CoinHop } from "./components/games/CoinHop";
import { PawnWars } from "./components/games/PawnWars";
import { MateInOne } from "./components/games/MateInOne";
import { MateInTwo } from "./components/games/MateInTwo";

type GameEntry = {
  id: string;
  emoji: string;
  title: string;
  blurb: string;
  render(): React.ReactNode;
};

const GAMES: GameEntry[] = [
  {
    id: "squareRace",
    emoji: "🎯",
    title: "Square Race",
    blurb: "Name that square — how many in 60 seconds?",
    render: () => <SquareRace />,
  },
  {
    id: "coinHop",
    emoji: "🪙",
    title: "Coin Hop",
    blurb: "Collect every coin in as few moves as you can.",
    render: () => <CoinHop pieces={["N", "B", "R", "Q", "K"]} />,
  },
  {
    id: "pawnWars",
    emoji: "⚔️",
    title: "Pawn Wars",
    blurb: "Pawns only — first to crown a queen wins.",
    render: () => <PawnWars />,
  },
  {
    id: "mateInOne",
    emoji: "♚",
    title: "Mate in 1",
    blurb: "Deliver checkmate in a single move.",
    render: () => <MateInOne />,
  },
  {
    id: "mateInTwo",
    emoji: "👑",
    title: "Mate in 2",
    blurb: "Force checkmate in two — think a move ahead.",
    render: () => <MateInTwo />,
  },
];

export default function ChessQuest() {
  const [open, setOpen] = useState<GameEntry | null>(null);

  return (
    <ProgressProvider>
      <CopyProvider register="classic">
        {open ? (
          <div className="flex flex-col">
            <div className="mx-auto w-full max-w-xl px-4 pt-3">
              <button
                type="button"
                onClick={() => setOpen(null)}
                className="text-sm font-medium text-purple-600 hover:text-purple-800"
              >
                ← All games
              </button>
            </div>
            {open.render()}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-8">
            <h2 className="mk-display text-3xl font-bold text-purple-950">Chess Quest</h2>
            <p className="mt-2 max-w-lg text-sm text-slate-600">
              Eight mini-games that teach real chess skills — pick one and play.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {GAMES.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setOpen(g)}
                  className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-purple-300 hover:shadow-md"
                >
                  <div className="text-3xl">{g.emoji}</div>
                  <h3 className="mk-display mt-2 text-lg font-bold text-purple-950">{g.title}</h3>
                  <p className="mt-1 text-xs text-slate-500">{g.blurb}</p>
                </button>
              ))}
            </div>
          </div>
        )}
      </CopyProvider>
    </ProgressProvider>
  );
}
