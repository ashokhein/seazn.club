"use client";

// Pawn Wars — hot-seat pawns-only race, first to promote wins. Port of
// js/games.js pawnWars (288–384): legal-target hints, promotion / stuck win
// conditions, and the coach interjection when the kid hangs a pawn for free.
import { useState } from "react";
import {
  allLegalMoves,
  applyMove,
  defendersOf,
  isAttacked,
  isWhitePiece,
  legalTargets,
} from "../../engine";
import { emptyBoard } from "../../lib/rand";
import { useCopy } from "../../lib/copy";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";

function startBoard(): string[] {
  const arr = emptyBoard();
  for (let f = 0; f < 8; f++) {
    arr[8 + f] = "p";
    arr[48 + f] = "P";
  }
  return arr;
}

type Chip = { label: string; onPick(): void };

export function PawnWars() {
  const progress = useProgress();
  const { t } = useCopy();
  const [position, setPosition] = useState<string[]>(startBoard);
  const [whiteToMove, setWhiteToMove] = useState(true);
  const [selIdx, setSelIdx] = useState(-1);
  const [over, setOver] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [shake, setShake] = useState(0);
  const [popN, setPopN] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);

  const turnStatus = (white: boolean) =>
    white
      ? t(
          "⬜ <strong>Kid’s move</strong> — race a pawn to the top!",
          "⬜ <strong>White to move</strong> — race a pawn to the top!",
        )
      : t("⬛ <strong>Grown-up’s move</strong>", "⬛ <strong>Black to move</strong>");

  const [status, setStatus] = useState(() => turnStatus(true));

  function fresh() {
    setPosition(startBoard());
    setWhiteToMove(true);
    setSelIdx(-1);
    setOver(false);
    setHighlights({});
    setChips([]);
    setStatus(turnStatus(true));
  }

  function win(whiteWon: boolean, why: string) {
    setOver(true);
    const stars = STAR_RULES.pawnWars(whiteWon);
    progress.setGameStars("pawnWars", stars);
    setChips([]);
    setStatus(
      `${
        whiteWon ? t("⬜ The kid wins", "⬜ White wins") : t("⬛ The grown-up wins", "⬛ Black wins")
      } — ${why} ${"★".repeat(stars)}`,
    );
    sfx.fanfare();
  }

  function bump() {
    const n = popN + 1;
    setPopN(n);
    return n;
  }

  function onTap(idx: number) {
    if (over) return;
    const pos = position;
    const p = pos[idx];
    const mine = p !== "" && isWhitePiece(p) === whiteToMove;

    if (mine) {
      setSelIdx(idx);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const target of legalTargets(pos, idx)) hl[target] = pos[target] === "" ? "move" : "cap";
      setHighlights(hl);
      return;
    }
    if (selIdx >= 0 && legalTargets(pos, selIdx).includes(idx)) {
      const next = applyMove(pos, selIdx, idx);
      setPosition(next);
      setHighlights({});
      setPop({ idx, n: bump() });
      sfx.move();
      setSelIdx(-1);

      if (next[idx] === "Q") return win(true, "a pawn was crowned! 👑");
      if (next[idx] === "q") return win(false, "a pawn was crowned! 👑");

      const nextWhite = !whiteToMove;
      if (allLegalMoves(next, nextWhite).length === 0) {
        return win(!nextWhite, nextWhite ? "white is stuck!" : "black is stuck!");
      }

      // Coach interjects if the kid just hung her pawn — she decides.
      if (!nextWhite && isAttacked(next, idx, false) && defendersOf(next, idx).length === 0) {
        const snap = pos;
        const after = next;
        setStatus("⚠️ Hold on — can black <strong>snack that pawn for free</strong>? Think…");
        setChips([
          {
            label: "Oops! Take back",
            onPick: () => {
              if (JSON.stringify(position) !== JSON.stringify(after)) {
                setStatus("Too late — the game moved on!");
                setChips([]);
                return;
              }
              setPosition(snap);
              setWhiteToMove(true);
              setHighlights({});
              setChips([]);
              setStatus("Good save! Look before you move — champion habit. ⬜ Your move again.");
            },
          },
          {
            label: "It’s my plan 😏",
            onPick: () => {
              setChips([]);
              setStatus("Brave! Sometimes a pawn is bait. ⬛ <strong>Grown-up’s move…</strong>");
            },
          },
        ]);
        setWhiteToMove(nextWhite);
        return;
      }

      setWhiteToMove(nextWhite);
      setStatus(turnStatus(nextWhite));
    } else if (selIdx >= 0) {
      setShake((s) => s + 1);
    }
  }

  return (
    <GameShell
      title="Pawn Wars"
      status={status}
      chips={chips}
      controls={
        <button type="button" className="btn btn-ghost" onClick={fresh}>
          Restart
        </button>
      }
    >
      <Board
        position={position}
        labels
        highlights={highlights}
        popToken={pop}
        shakeToken={shake}
        onTap={onTap}
      />
    </GameShell>
  );
}
