"use client";

// Tap-to-move chess board (React port of the original js/board.js).
// Controlled: position/highlights/coins come in as props; taps go out.
// pop/shake are token-driven so a parent can retrigger CSS animations.
import { useEffect, useRef, useState } from "react";
import { FILES, fileOf, isWhitePiece, rankRow, sqName } from "../engine";

export const GLYPH: Record<string, string> = {
  P: "♟",
  N: "♞",
  B: "♝",
  R: "♜",
  Q: "♛",
  K: "♚",
};

const PIECE_NAMES: Record<string, string> = {
  P: "pawn",
  N: "knight",
  B: "bishop",
  R: "rook",
  Q: "queen",
  K: "king",
};

export type Highlight = "sel" | "move" | "cap" | "hint";

export function Board({
  position,
  highlights,
  coins,
  labels = false,
  onTap,
  popToken,
  shakeToken,
}: {
  position: string[];
  highlights?: Partial<Record<number, Highlight>>;
  coins?: ReadonlySet<number>;
  labels?: boolean;
  onTap?(idx: number): void;
  popToken?: { idx: number; n: number } | null;
  shakeToken?: number;
}) {
  // Re-mount the popped piece span so the CSS animation restarts.
  const [popping, setPopping] = useState<{ idx: number; n: number } | null>(null);
  useEffect(() => {
    if (popToken) setPopping(popToken);
  }, [popToken]);

  const [shaking, setShaking] = useState(false);
  const firstShake = useRef(true);
  useEffect(() => {
    if (firstShake.current) {
      firstShake.current = false;
      return;
    }
    setShaking(true);
    const t = setTimeout(() => setShaking(false), 320);
    return () => clearTimeout(t);
  }, [shakeToken]);

  const squares = [];
  for (let idx = 0; idx < 64; idx++) {
    const p = position[idx];
    const name = sqName(idx);
    const hl = highlights?.[idx];
    const light = (fileOf(idx) + rankRow(idx)) % 2 === 0;
    const label = p !== "" ? `${name} ${isWhitePiece(p) ? "white" : "black"} ${PIECE_NAMES[p.toUpperCase()]}` : name;
    squares.push(
      <button
        key={idx}
        type="button"
        data-square={name}
        aria-label={label}
        data-rank={labels && fileOf(idx) === 0 ? 8 - rankRow(idx) : undefined}
        data-file={labels && rankRow(idx) === 7 ? FILES[fileOf(idx)] : undefined}
        className={`cq-sq ${light ? "cq-light" : "cq-dark"}${hl ? ` cq-hl-${hl}` : ""}`}
        onClick={onTap ? () => onTap(idx) : undefined}
      >
        {p !== "" ? (
          // Classic Cburnett SVG pieces (see public/games/chess-quest/pieces/LICENSE.md)
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={popping?.idx === idx ? `pop-${popping.n}` : "pc"}
            src={`/games/chess-quest/pieces/${p.toLowerCase()}${isWhitePiece(p) ? "l" : "d"}.svg`}
            alt=""
            draggable={false}
            className={`cq-pc${popping?.idx === idx ? " cq-pop" : ""}`}
          />
        ) : coins?.has(idx) ? (
          <span className="cq-coin" />
        ) : null}
      </button>,
    );
  }

  return <div className={`cq-board${shaking ? " cq-shake" : ""}`}>{squares}</div>;
}
