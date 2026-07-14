"use client";

// Piece Detective — tap the black piece that's free to take (attacked and
// undefended). Port of js/games.js hangingHunt (810–926): targeted coaching
// for wrong taps, tap-the-guard flow for defended pieces.
import { useCallback, useEffect, useState } from "react";
import {
  attackSquares,
  defendersOf,
  isAttacked,
  isWhitePiece,
  parseFEN,
  sqIdx,
} from "../../engine";
import { HUNTS } from "../../content/puzzles";
import { useCopy } from "../../lib/copy";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";
import { PuzzleDots } from "./PuzzleDots";

function firstUnsolved(isHuntSolved: (i: number) => boolean) {
  for (let i = 0; i < HUNTS.length; i++) if (!isHuntSolved(i)) return i;
  return 0;
}

export function HangingHunt() {
  const progress = useProgress();
  const { isStory } = useCopy();
  const { later, clearPending } = useLater();
  const [cur, setCur] = useState(() => firstUnsolved(progress.isHuntSolved));
  const [position, setPosition] = useState<string[]>(() => parseFEN(HUNTS[cur].fen).board);
  const [busy, setBusy] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [coachTap, setCoachTap] = useState<((idx: number) => void) | null>(null);

  const prompt = useCallback(
    (h: (typeof HUNTS)[number]) =>
      `${isStory() ? `<em>${h.story}</em><br>` : ""}Tap the black piece that is <strong>free to take</strong> — attacked, and nobody guards it!`,
    [isStory],
  );

  const [status, setStatus] = useState(() => prompt(HUNTS[cur]));

  const load = useCallback(
    (i: number) => {
      clearPending();
      setCur(i);
      setPosition(parseFEN(HUNTS[i].fen).board);
      setHighlights({});
      setBusy(false);
      setCoachTap(null);
      setStatus(prompt(HUNTS[i]));
    },
    [clearPending, prompt],
  );

  useEffect(() => () => clearPending(), [clearPending]);

  function solved(i: number) {
    progress.setHuntSolved(i);
    const n = progress.huntCount();
    progress.setGameStars("hangingHunt", STAR_RULES.hangingHunt(n));
    setStatus("<strong>Found it!</strong> 🔍 Free stuff detected.");
    sfx.coin();
    setBusy(true);
    later(() => {
      if (n < HUNTS.length) load(firstUnsolved(progress.isHuntSolved));
      else {
        setStatus(
          "<strong>All cases closed!</strong> Official Free-Stuff Detector badge earned. ★★★",
        );
        sfx.fanfare();
      }
    }, 1300);
  }

  function onTap(idx: number) {
    if (coachTap) {
      coachTap(idx);
      return;
    }
    if (busy) return;
    const h = HUNTS[cur];
    if (idx === sqIdx(h.answer)) {
      setHighlights({ [idx]: "hint" });
      setPop({ idx, n: popN + 1 });
      setPopN((v) => v + 1);
      solved(cur);
      return;
    }
    const pos = position;
    const p = pos[idx];
    if (p === "" || isWhitePiece(p)) {
      setShake((s) => s + 1);
      sfx.bad();
      setStatus("Tap a <strong>black</strong> piece — we’re hunting black’s loose ones!");
    } else if (p === "k") {
      setShake((s) => s + 1);
      sfx.bad();
      setStatus("Kings can never be taken — only checkmated! Hunt for a piece.");
    } else if (!isAttacked(pos, idx, true)) {
      setShake((s) => s + 1);
      sfx.bad();
      setStatus("Is anything even <strong>attacking</strong> that one? Trace every white piece’s path…");
    } else {
      const guards = defendersOf(pos, idx);
      sfx.bad();
      setStatus("It IS attacked — but it has a bodyguard! <strong>Tap the guard.</strong>");
      setCoachTap(() => (t: number) => {
        setCoachTap(null);
        if (guards.includes(t)) {
          setHighlights({ [t]: "hint" });
          sfx.good();
          setStatus("That’s the bodyguard! Free stuff has <strong>no</strong> guards. Keep hunting!");
        } else {
          setHighlights(Object.fromEntries(guards.map((g) => [g, "hint" as Highlight])));
          setStatus("The glowing one guards it. Free stuff has no guards — keep hunting!");
        }
      });
    }
  }

  function hint() {
    const pos = position;
    const ans = sqIdx(HUNTS[cur].answer);
    const hl: Partial<Record<number, Highlight>> = {};
    for (let i = 0; i < 64; i++) {
      const p = pos[i];
      if (p !== "" && isWhitePiece(p) && attackSquares(pos, i).includes(ans)) hl[i] = "hint";
    }
    setHighlights(hl);
    setStatus(
      `${isStory() ? `<em>${HUNTS[cur].story}</em><br>` : ""}Follow the glowing piece — what can it grab for free?`,
    );
  }

  return (
    <GameShell
      title="Piece Detective"
      score={`🔍 ${progress.huntCount()} / ${HUNTS.length} cases`}
      status={status}
      extra={
        <PuzzleDots
          count={HUNTS.length}
          current={cur}
          isSolved={progress.isHuntSolved}
          onPick={load}
          label="Case"
        />
      }
      controls={
        <>
          <button type="button" className="btn btn-ghost" onClick={hint}>
            Hint
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              progress.resetHunts();
              load(0);
            }}
          >
            Start cases over
          </button>
        </>
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
