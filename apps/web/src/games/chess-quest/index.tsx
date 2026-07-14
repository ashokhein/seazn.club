"use client";

// Temporary Phase C2 preview: renders the Board inside GameShell to verify
// the chrome in the browser. Task C7 replaces this with the game hub.
import "./chess-quest.css";
import { useState } from "react";
import { parseFEN, sqName } from "./engine";
import { Board } from "./components/Board";
import { GameShell } from "./components/GameShell";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export default function ChessQuest() {
  const [last, setLast] = useState<string>("");
  const [shake, setShake] = useState(0);
  return (
    <GameShell
      title="Chess Quest"
      score="board preview"
      status={last ? `You tapped <strong>${last}</strong>` : "Tap any square."}
      controls={
        <button type="button" className="btn btn-ghost" onClick={() => setShake((s) => s + 1)}>
          Shake
        </button>
      }
    >
      <Board
        position={parseFEN(START).board}
        labels
        shakeToken={shake}
        onTap={(idx) => setLast(sqName(idx))}
      />
    </GameShell>
  );
}
