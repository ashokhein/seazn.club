"use client";

// Lesson card — the selected day's Learn/Play/Tip, an optional diagram board,
// a Play button that launches the lesson's mini-game, and a mark-done toggle.
// Port of js/app.js renderCard (129–187).
import { parseFEN, pieceTargets, sqIdx } from "../../engine";
import { LANDS } from "../../content/lands";
import { GameId, LESSONS } from "../../content/lessons";
import { celebrate } from "../../lib/celebrate";
import { useCopy } from "../../lib/copy";
import { useProgress } from "../../lib/progress";
import { sfx } from "../../lib/sfx";
import { Board, Highlight } from "../Board";
import { Rich } from "../rich";
import { dayOf, GAME_LABEL, lessonCopy } from "./questData";

export function LessonCard({
  n,
  onPlay,
}: {
  n: number;
  onPlay(game: GameId, opts: Record<string, unknown>): void;
}) {
  const progress = useProgress();
  const { t, isStory } = useCopy();
  const wk = LESSONS[n - 1];
  const land = LANDS[wk.land - 1];
  const isDone = progress.isWeekDone(wk.n);
  const isLast = wk.n === land.weeks[1];
  const c = lessonCopy(wk, isStory());
  const landCheck = !isStory() && land.checkClassic ? land.checkClassic : land.check;

  let diagramHl: Partial<Record<number, Highlight>> | undefined;
  let diagramPos: string[] | undefined;
  if (wk.diagram) {
    diagramPos = parseFEN(wk.diagram.fen).board;
    if (wk.diagram.from) {
      const from = sqIdx(wk.diagram.from);
      diagramHl = { [from]: "sel" };
      for (const tgt of pieceTargets(diagramPos, from)) diagramHl[tgt] = "move";
    }
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5">
      <span className="text-xs font-semibold uppercase tracking-wide text-purple-400">
        {land.glyph} {land.name} · Day {dayOf(wk.n)}
      </span>
      <h2 className="mk-display mt-1 text-2xl font-bold text-purple-950">{wk.title}</h2>

      <dl className="mt-3 flex flex-col gap-2 text-sm">
        <div className="flex gap-3">
          <dt className="w-12 shrink-0 font-bold text-purple-700">Learn</dt>
          <dd className="text-slate-600">
            <Rich html={c.learn} />
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-12 shrink-0 font-bold text-purple-700">Play</dt>
          <dd className="text-slate-600">
            <Rich html={c.play} />
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-12 shrink-0 font-bold text-amber-600">{t("Spark", "Tip")}</dt>
          <dd className="text-slate-600">
            <Rich html={c.spark} />
          </dd>
        </div>
      </dl>

      {wk.diagram && diagramPos ? (
        <div className="mt-4">
          <div className="mx-auto max-w-64">
            <Board position={diagramPos} highlights={diagramHl} />
          </div>
          <p className="mt-1 text-center text-xs italic text-slate-500">{wk.diagram.caption}</p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {wk.game ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onPlay(wk.game as GameId, wk.gameOpts ?? {})}
          >
            {GAME_LABEL[wk.game]}
          </button>
        ) : null}
        <button
          type="button"
          className={isDone ? "btn btn-ghost" : "btn btn-primary"}
          onClick={(e) => {
            const was = isDone;
            progress.setWeekDone(wk.n, !was);
            if (!was) {
              sfx.chime();
              if (progress.landDone(land)) celebrate(e.currentTarget);
            }
          }}
        >
          {isDone ? "✓ Done — undo?" : "Mark day done ⭐"}
        </button>
      </div>

      {isLast ? (
        <p className="mt-4 rounded-lg bg-purple-50 p-3 text-sm text-purple-900">
          <b>
            {land.glyph} Level-up check:
          </b>{" "}
          {landCheck}
        </p>
      ) : null}
    </div>
  );
}
