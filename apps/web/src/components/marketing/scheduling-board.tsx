"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createBoard, isFull, place, type BoardState } from "@/lib/marketing/board-logic";
import { useT } from "@/components/i18n/dict-provider";

const COURTS = 3;

/** Attract-mode board (design/v3/12 §5): plays the matchday replay once,
 *  hands over to the visitor on first touch (or when the replay ends), and
 *  lights Publish when every fixture is placed clash-free. Tap-a-chip then
 *  tap-a-court is the baseline mechanism — it is also the keyboard path.
 *  Copy comes from the `marketing` dict via a <DictProvider> the /scheduling
 *  page wraps this island in (demo team names included, for a localized feel). */
export function SchedulingBoard() {
  const t = useT();
  const fixturesRef = useRef<string[]>([
    t("sched.board.fixture.1"),
    t("sched.board.fixture.2"),
    t("sched.board.fixture.3"),
  ]);
  const fixtures = fixturesRef.current;
  const [mode, setMode] = useState<"replay" | "play" | "published">("replay");
  const [board, setBoard] = useState<BoardState>(() => createBoard(fixtures, COURTS));
  const [armed, setArmed] = useState<number | null>(null);
  const [status, setStatus] = useState(() => t("sched.board.status.initial"));
  const replayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Attract mode: skip straight to play under reduced motion; otherwise hand
  // over when the CSS replay (~3.2s) finishes or on first pointer/key contact.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMode("play");
      return;
    }
    replayTimer.current = setTimeout(() => setMode("play"), 3400);
    return () => {
      if (replayTimer.current) clearTimeout(replayTimer.current);
    };
  }, []);
  const takeover = () => {
    if (mode === "replay") {
      if (replayTimer.current) clearTimeout(replayTimer.current);
      setMode("play");
    }
  };

  function placeChip(fixtureIdx: number, court: number) {
    const next = place(board, fixtureIdx, court);
    setBoard(next);
    setArmed(null);
    if (next.courts[court]!.clash) {
      setStatus(t("sched.board.status.clash", { court: court + 1 }));
    } else if (isFull(next)) {
      setStatus(t("sched.board.status.full"));
    } else {
      setStatus(t("sched.board.status.placed"));
    }
  }

  if (mode === "published") {
    return (
      <div data-testid="board-player-view" className="rounded-xl bg-[var(--mk-night)] p-6 text-center">
        <p className="mk-display text-xs tracking-[0.2em] text-[var(--mk-lime)]">
          {t("sched.board.publishedLabel")}
        </p>
        <ul className="mx-auto mt-4 max-w-sm space-y-2 text-left">
          {board.courts.map((c, i) =>
            c.placed.map((f) => (
              <li
                key={f}
                className="flex justify-between rounded-lg bg-[#241650] px-3 py-2 text-sm text-[var(--mk-cream)]"
              >
                <span>{f}</span>
                <span className="mk-display text-[var(--mk-lime)]">{t("sched.board.court", { n: i + 1 })}</span>
              </li>
            )),
          )}
        </ul>
        <Link
          href="/start"
          className="mk-display mt-6 inline-block rounded-xl bg-[var(--mk-lime)] px-6 py-2.5 font-bold text-[var(--mk-night)]"
        >
          {t("sched.board.runMatchday")}
        </Link>
      </div>
    );
  }

  return (
    <div onPointerDown={takeover} onKeyDown={takeover}>
      {mode === "replay" ? (
        <div className="mk-board-replay rounded-xl bg-[var(--mk-night)] p-4" aria-hidden>
          <div className="space-y-2">
            {[0, 1, 2].map((lane) => (
              <div key={lane} className="relative h-8 overflow-hidden rounded-lg bg-[#241650]">
                <span
                  className={`mk-replay-chip mk-replay-chip-${lane} absolute inset-y-1 rounded bg-[var(--mk-purple)]`}
                />
                {lane === 1 ? (
                  <span className="mk-replay-fix absolute inset-y-1 rounded bg-[var(--mk-lime)]" />
                ) : null}
              </div>
            ))}
          </div>
          <p className="mk-display mt-3 text-[11px] tracking-[0.18em] text-[#8d7fc0]">
            {t("sched.board.replayCaption")}
          </p>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label={t("sched.board.trayAria")}>
            {board.tray.map((f, i) => (
              <button
                key={f}
                data-testid="board-chip"
                aria-pressed={armed === i}
                onClick={() => setArmed(armed === i ? null : i)}
                className={`cursor-grab rounded-lg px-3 py-1.5 text-xs font-semibold ${
                  armed === i
                    ? "bg-[var(--mk-lime)] text-[var(--mk-night)]"
                    : "bg-[var(--mk-purple)] text-white"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="space-y-2 rounded-xl bg-[var(--mk-night)] p-4">
            {board.courts.map((c, court) => (
              <button
                key={court}
                data-testid={`board-court-${court}`}
                aria-label={
                  t("sched.board.court", { n: court + 1 }) +
                  (c.placed.length
                    ? `, ${c.placed.join(` ${t("sched.board.and")} `)}`
                    : `, ${t("sched.board.courtEmpty")}`)
                }
                onClick={() => armed !== null && placeChip(armed, court)}
                className={`flex min-h-11 w-full flex-wrap items-center gap-2 rounded-lg p-1.5 text-left ${
                  c.clash
                    ? "bg-[#3f1d2e] outline outline-2 outline-[var(--mk-live)]"
                    : "bg-[#241650]"
                } ${armed !== null && !c.clash ? "outline-dashed outline-2 outline-[var(--mk-lime)]" : ""}`}
              >
                <span className="mk-display w-16 shrink-0 text-[11px] tracking-[0.12em] text-[#8d7fc0]">
                  {t("sched.board.courtShort", { n: court + 1 })}
                </span>
                {c.placed.map((f) => (
                  <span
                    key={f}
                    className={`rounded px-2 py-1 text-xs font-semibold ${
                      c.clash ? "bg-[var(--mk-live)] text-white" : "bg-[var(--mk-purple)] text-white"
                    }`}
                  >
                    {f}
                  </span>
                ))}
              </button>
            ))}
          </div>
          <p data-testid="board-status" aria-live="polite" className="mt-3 min-h-5 text-sm text-slate-600">
            {status}
          </p>
          {isFull(board) ? (
            <button
              data-testid="board-publish"
              onClick={() => setMode("published")}
              className="mk-display mt-3 rounded-xl bg-[var(--mk-lime)] px-6 py-2.5 font-bold text-[var(--mk-night)]"
            >
              {t("sched.board.publishToPlayers")}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
