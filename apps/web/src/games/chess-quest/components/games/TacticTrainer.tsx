"use client";

// Trick Shots — play a move that pulls off the pack's tactic. Port of
// js/games.js tacticTrainer (928–1092), plus a free-play pack picker (the
// hub has no curriculum context to choose a pack for us).
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyMove,
  attackSquares,
  attackersOf,
  Board as BoardType,
  isAttacked,
  isDiscoveredAfter,
  isForkAfter,
  isPinAfter,
  isSkewerAfter,
  isWhitePiece,
  legalTargets,
  parseFEN,
  sqIdx,
} from "../../engine";
import { TACTICS, TACTICS2 } from "../../content/puzzles";
import { useCopy } from "../../lib/copy";
import { sfx } from "../../lib/sfx";
import { STAR_RULES } from "../../lib/stars";
import { useLater } from "../../lib/use-later";
import { useProgress } from "../../lib/progress";
import { Board, Highlight } from "../Board";
import { GameShell } from "../GameShell";
import { PuzzleDots } from "./PuzzleDots";
import { Chip } from "./mate-miss-coach";

const PACK_INFO: Record<string, { name: string; ask: string }> = {
  fork: { name: "The Fork", ask: "Play a move that attacks TWO things at once!" },
  pin: { name: "The Pin", ask: "Play a move that freezes a piece to something precious behind it!" },
  skewer: { name: "The Skewer", ask: "Attack the big one in front — grab what hides behind!" },
  disco: { name: "Discovered Attack", ask: "Move one piece so the piece behind it attacks — surprise!" },
  fork2: { name: "The Fork — Master", ask: "Fork two big pieces from a square nobody can punish!" },
  pin2: { name: "The Pin — Master", ask: "Build the line of three: you, their piece, their treasure behind it." },
  skewer2: { name: "The Skewer — Master", ask: "Poke the big one in front so it must run — collect what hides behind." },
  disco2: { name: "Discovered Attack — Master", ask: "Move one piece, unleash another — make BOTH of them threaten something!" },
};

const DETECTOR: Record<string, (b: BoardType, to: number) => boolean> = {
  fork: isForkAfter,
  pin: isPinAfter,
  skewer: isSkewerAfter,
  disco: (b, to) => isDiscoveredAfter(b, to, true),
};
DETECTOR.fork2 = DETECTOR.fork;
DETECTOR.pin2 = DETECTOR.pin;
DETECTOR.skewer2 = DETECTOR.skewer;
DETECTOR.disco2 = DETECTOR.disco;

const TIER1 = ["fork", "pin", "skewer", "disco"];
const TIER2 = ["fork2", "pin2", "skewer2", "disco2"];
const PACK_GLYPH: Record<string, string> = {
  fork: "🍴",
  pin: "📌",
  skewer: "🍢",
  disco: "🎭",
  fork2: "🍴",
  pin2: "📌",
  skewer2: "🍢",
  disco2: "🎭",
};

function casesOf(pack: string) {
  return (TACTICS as Record<string, { fen: string; solution: string; story: string }[]>)[pack] ??
    (TACTICS2 as Record<string, { fen: string; solution: string; story: string }[]>)[pack];
}

export function TacticTrainer({ pack: initialPack = "fork" }: { pack?: string }) {
  const progress = useProgress();
  const { isStory } = useCopy();
  const { later, clearPending } = useLater();
  const [pack, setPack] = useState(initialPack);
  const cases = useMemo(() => casesOf(pack), [pack]);
  const info = PACK_INFO[pack];

  const firstUnsolved = useCallback(() => {
    for (let i = 0; i < cases.length; i++) if (!progress.isTacticSolved(pack, i)) return i;
    return 0;
  }, [cases.length, pack, progress]);

  const [cur, setCur] = useState(() => firstUnsolved());
  const [position, setPosition] = useState<string[]>(() => parseFEN(cases[cur].fen).board);
  const [selIdx, setSelIdx] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [highlights, setHighlights] = useState<Partial<Record<number, Highlight>>>({});
  const [pop, setPop] = useState<{ idx: number; n: number } | null>(null);
  const [popN, setPopN] = useState(0);
  const [shake, setShake] = useState(0);
  const [chips, setChips] = useState<Chip[]>([]);
  const [coachTap, setCoachTap] = useState<((idx: number) => void) | null>(null);

  const prompt = useCallback(
    (c: { story: string }) =>
      `${isStory() ? `<em>${c.story}</em><br>` : ""}${info.ask}`,
    [info.ask, isStory],
  );

  const [status, setStatus] = useState(() => prompt(cases[cur]));

  const load = useCallback(
    (p: string, i: number) => {
      clearPending();
      const cs = casesOf(p);
      setPack(p);
      setCur(i);
      setPosition(parseFEN(cs[i].fen).board);
      setHighlights({});
      setSelIdx(-1);
      setBusy(false);
      setChips([]);
      setCoachTap(null);
      setStatus(`${isStory() ? `<em>${cs[i].story}</em><br>` : ""}${PACK_INFO[p].ask}`);
    },
    [clearPending, isStory],
  );

  useEffect(() => () => clearPending(), [clearPending]);

  function solved() {
    progress.setTacticSolved(pack, cur);
    const tier2 = pack.endsWith("2");
    const keys = tier2 ? TIER2 : TIER1;
    const total = keys.reduce((s, p) => s + progress.tacticCount(p), 0);
    progress.setGameStars(
      tier2 ? "tacticTrainer2" : "tacticTrainer",
      tier2 ? STAR_RULES.packStars(total) : STAR_RULES.tacticTier1(total),
    );
    setStatus(`<strong>${info.name}!</strong> 🎯 Beautifully done.`);
    sfx.fanfare();
    setBusy(true);
    later(() => {
      const n = progress.tacticCount(pack);
      if (n < cases.length) {
        for (let i = 0; i < cases.length; i++)
          if (!progress.isTacticSolved(pack, i)) {
            load(pack, i);
            return;
          }
      } else {
        setStatus(`<strong>${info.name} mastered!</strong> Try the other tricks with the chips above.`);
      }
    }, 1400);
  }

  function onTap(idx: number) {
    if (coachTap) {
      coachTap(idx);
      return;
    }
    if (busy) return;
    const pos = position;
    const p = pos[idx];
    if (p !== "" && isWhitePiece(p)) {
      setSelIdx(idx);
      const hl: Partial<Record<number, Highlight>> = { [idx]: "sel" };
      for (const t of legalTargets(pos, idx)) hl[t] = pos[t] === "" ? "move" : "cap";
      setHighlights(hl);
      return;
    }
    if (selIdx < 0 || !legalTargets(pos, selIdx).includes(idx)) {
      if (selIdx >= 0) {
        setShake((s) => s + 1);
        sfx.bad();
      }
      return;
    }

    const next = applyMove(pos, selIdx, idx);
    setSelIdx(-1);
    if (DETECTOR[pack](next, idx)) {
      setPosition(next);
      setHighlights({});
      setPop({ idx, n: popN + 1 });
      setPopN((v) => v + 1);
      solved();
      return;
    }

    // Wrong move — pack-specific coaching, then reset the puzzle.
    setPosition(next);
    setHighlights({});
    sfx.bad();
    setBusy(true);
    const resetFen = cases[cur].fen;
    const backSoon = (msg: string) =>
      later(() => {
        setPosition(parseFEN(resetFen).board);
        setShake((s) => s + 1);
        setBusy(false);
        setChips([]);
        setCoachTap(null);
        setStatus(msg);
      }, 500);

    if (pack === "fork" || pack === "fork2") {
      const hits = attackSquares(next, idx).filter(
        (t) => next[t] !== "" && !isWhitePiece(next[t]) && next[t] !== "p",
      );
      if (isAttacked(next, idx, false)) {
        const eaters = attackersOf(next, idx, false);
        setStatus(
          "Uh-oh — that square is dangerous! <strong>Tap the enemy</strong> that could eat your piece there.",
        );
        setCoachTap(() => (t: number) => {
          setCoachTap(null);
          if (eaters.includes(t)) {
            setHighlights({ [t]: "cap" });
            sfx.good();
            backSoon("You spotted it! A fork only works from a <strong>safe</strong> square. Try again.");
          } else {
            setHighlights(Object.fromEntries(eaters.map((e) => [e, "cap" as Highlight])));
            backSoon("It was the glowing one! Safe square first, fork second. Go again.");
          }
        });
      } else {
        const n = hits.length;
        setStatus("Count with me — how many big enemy pieces does it attack from there?");
        setChips([
          {
            label: String(n),
            onPick: () =>
              backSoon(
                `Yes — ${n === 1 ? "just one" : n}! A fork needs <strong>two at once</strong>. Hunt for the magic square!`,
              ),
          },
          {
            label: String(n === 2 ? 1 : 2),
            onPick: () => backSoon(`Count slowly next time — it was ${n}. A fork needs two at once!`),
          },
        ]);
      }
    } else if (pack === "pin" || pack === "pin2") {
      backSoon(
        "A pin is a line of three: you → their piece → something <strong>precious hiding behind</strong>. Did your move build that line? Look for the stack!",
      );
    } else if (pack === "skewer" || pack === "skewer2") {
      backSoon(
        "A skewer pokes the <strong>big one in front</strong> so it must run. What treasure stands behind it? Find that line!",
      );
    } else {
      backSoon(
        "The magic piece is the one <strong>behind</strong>: step aside and let a hidden friend attack. Which of your pieces is blocking a friend?",
      );
    }
  }

  function hint() {
    setHighlights({ [sqIdx(cases[cur].solution.slice(0, 2))]: "hint" });
  }

  const allPacks = [...TIER1, ...TIER2];

  return (
    <GameShell
      title={`Trick Shots — ${info.name}`}
      score={`🎯 ${progress.tacticCount(pack)} / ${cases.length}`}
      status={status}
      chips={chips}
      extra={
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap justify-center gap-1.5">
            {allPacks.map((pk) => (
              <button
                key={pk}
                type="button"
                onClick={() => load(pk, 0)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium ${
                  pk === pack
                    ? "border-purple-600 bg-purple-600 text-white"
                    : "border-purple-300 bg-white text-purple-800 hover:bg-purple-50"
                }`}
              >
                {PACK_GLYPH[pk]} {PACK_INFO[pk].name}
              </button>
            ))}
          </div>
          <PuzzleDots
            count={cases.length}
            current={cur}
            isSolved={(i) => progress.isTacticSolved(pack, i)}
            onPick={(i) => load(pack, i)}
          />
        </div>
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
              progress.resetTactics(pack);
              load(pack, 0);
            }}
          >
            Start pack over
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
