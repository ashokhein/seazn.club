"use client";

// Chess Quest — the quest journey (48 lessons over 9 lands) is the landing;
// the eight mini-games are also reachable as a free-play arcade. Lessons launch
// their game with the lesson's gameOpts; progress persists per player profile.
import "./chess-quest.css";
import { useState } from "react";
import { GameId } from "./content/lessons";
import { CopyProvider } from "./lib/copy";
import { ProgressProvider, useProgress } from "./lib/progress";
import { useDeviceAudio } from "./lib/use-device-audio";
import { SquareRace } from "./components/games/SquareRace";
import { CoinHop } from "./components/games/CoinHop";
import { PawnWars } from "./components/games/PawnWars";
import { MateInOne } from "./components/games/MateInOne";
import { MateInTwo } from "./components/games/MateInTwo";
import { HangingHunt } from "./components/games/HangingHunt";
import { TacticTrainer } from "./components/games/TacticTrainer";
import { RookMaze } from "./components/games/RookMaze";
import { OpeningTrainer } from "./components/games/OpeningTrainer";
import { Certificate } from "./components/quest/Certificate";
import { GrownUpsDrawer } from "./components/quest/GrownUpsDrawer";
import { LessonCard } from "./components/quest/LessonCard";
import { ProfilePanel } from "./components/quest/ProfilePanel";
import { ProgressPanel } from "./components/quest/ProgressPanel";
import { QuestHeader } from "./components/quest/QuestHeader";
import { QuestMap } from "./components/quest/QuestMap";
import { LESSONS } from "./content/lessons";

type Opts = Record<string, unknown>;

// Render a game by id, applying lesson gameOpts (falling back to the fuller
// free-play defaults when a lesson passes none).
function renderGame(game: GameId, opts: Opts) {
  const pieces = (opts.pieces as string[] | undefined) ?? undefined;
  const pack = (opts.pack as string | undefined) ?? undefined;
  const opening = (opts.opening as string | undefined) ?? undefined;
  switch (game) {
    case "squareRace":
      return <SquareRace />;
    case "coinHop":
      return <CoinHop pieces={pieces ?? ["N", "B", "R", "Q", "K"]} />;
    case "pawnWars":
      return <PawnWars />;
    case "mateInOne":
      return <MateInOne />;
    case "mateInTwo":
      return <MateInTwo />;
    case "hangingHunt":
      return <HangingHunt />;
    case "tacticTrainer":
      return <TacticTrainer pack={pack ?? "fork"} />;
    case "rookMaze":
      return <RookMaze pieces={pieces ?? ["R", "B", "Q"]} />;
    case "openingTrainer":
      return <OpeningTrainer opening={opening ?? "italian"} />;
  }
}

const ARCADE: { id: GameId; emoji: string; title: string; blurb: string; opts: Opts }[] = [
  { id: "squareRace", emoji: "🎯", title: "Square Race", blurb: "Name that square — how many in 60 seconds?", opts: {} },
  { id: "coinHop", emoji: "🪙", title: "Coin Hop", blurb: "Collect every coin in as few moves as you can.", opts: {} },
  { id: "pawnWars", emoji: "⚔️", title: "Pawn Wars", blurb: "Pawns only — first to crown a queen wins.", opts: {} },
  { id: "mateInOne", emoji: "♚", title: "Mate in 1", blurb: "Deliver checkmate in a single move.", opts: {} },
  { id: "mateInTwo", emoji: "👑", title: "Mate in 2", blurb: "Force checkmate in two — think a move ahead.", opts: {} },
  { id: "hangingHunt", emoji: "🔍", title: "Piece Detective", blurb: "Spot the piece that's free to take.", opts: {} },
  { id: "tacticTrainer", emoji: "🎯", title: "Trick Shots", blurb: "Forks, pins, skewers, discovered attacks.", opts: { pack: "fork" } },
  { id: "rookMaze", emoji: "🧩", title: "Rook Maze", blurb: "Slide around the walls to catch the prey.", opts: {} },
  { id: "openingTrainer", emoji: "📖", title: "Opening Trainer", blurb: "Play a real opening, move by move.", opts: { opening: "italian" } },
];

function QuestApp() {
  const progress = useProgress();
  useDeviceAudio();
  const [view, setView] = useState<"quest" | "arcade">("quest");
  const [selected, setSelected] = useState(() => progress.currentWeek(LESSONS.length));
  const [game, setGame] = useState<{ game: GameId; opts: Opts; back: "quest" | "arcade" } | null>(
    null,
  );
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);

  // A launched game takes the whole area with a back bar.
  if (game) {
    return (
      <div className="flex flex-col">
        <div className="mx-auto w-full max-w-xl px-4 pt-3">
          <button
            type="button"
            onClick={() => setGame(null)}
            className="text-sm font-medium text-purple-600 hover:text-purple-800"
          >
            {game.back === "quest" ? "← Back to quest" : "← All games"}
          </button>
        </div>
        {renderGame(game.game, game.opts)}
        <Certificate />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6">
      <div className="mb-4 inline-flex rounded-full border border-purple-200 bg-white p-1">
        {(["quest", "arcade"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={`rounded-full px-4 py-1 text-sm font-medium ${
              view === v ? "bg-purple-600 text-white" : "text-purple-700 hover:bg-purple-50"
            }`}
          >
            {v === "quest" ? "Quest" : "Free play"}
          </button>
        ))}
      </div>

      {view === "quest" ? (
        <div className="flex flex-col gap-5">
          <QuestHeader
            onOpenProfiles={() => setProfilesOpen(true)}
            onOpenProgress={() => setProgressOpen(true)}
          />
          <div className="grid gap-5 lg:grid-cols-2">
            <QuestMap selected={selected} onSelect={setSelected} />
            <div className="flex flex-col gap-4">
              <LessonCard
                n={selected}
                onPlay={(g, opts) => setGame({ game: g, opts, back: "quest" })}
              />
              <GrownUpsDrawer />
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {ARCADE.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setGame({ game: a.id, opts: a.opts, back: "arcade" })}
              className="rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-purple-300 hover:shadow-md"
            >
              <div className="text-3xl">{a.emoji}</div>
              <h3 className="mk-display mt-2 text-lg font-bold text-purple-950">{a.title}</h3>
              <p className="mt-1 text-xs text-slate-500">{a.blurb}</p>
            </button>
          ))}
        </div>
      )}

      {profilesOpen ? <ProfilePanel onClose={() => setProfilesOpen(false)} /> : null}
      {progressOpen ? (
        <ProgressPanel
          onClose={() => setProgressOpen(false)}
          onPrint={() => {
            if (typeof window !== "undefined") window.print();
          }}
        />
      ) : null}
      <Certificate />
    </div>
  );
}

function RegisterBridge() {
  // Reads the active profile's mode so copy re-renders when it changes.
  const progress = useProgress();
  return (
    <CopyProvider register={progress.getMode()}>
      <QuestApp />
    </CopyProvider>
  );
}

export default function ChessQuest() {
  return (
    <ProgressProvider>
      <RegisterBridge />
    </ProgressProvider>
  );
}
