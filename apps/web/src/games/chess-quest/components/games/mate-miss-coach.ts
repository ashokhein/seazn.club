// Drives the "why wasn't that mate?" coach flow for the mate games — a direct
// port of js/games.js mateMissCoach (386–429). Given the board after a wrong
// move and a set of game callbacks, it diagnoses no-check / escapable /
// capturable and walks the player toward the fix, then resets.
import { Board } from "../../engine";
import { classifyMateMiss } from "../../lib/mate-miss";
import { Highlight } from "../Board";

export type Chip = { label: string; onPick(): void };

export type MateMissCtx = {
  next: Board; // board after the non-mating move
  resetBoard: Board; // board to restore to
  extraNudge: string;
  setStatus(s: string): void;
  setChips(c: Chip[]): void;
  setCoachTap(fn: ((idx: number) => void) | null): void;
  setPosition(b: Board): void;
  setHighlights(h: Partial<Record<number, Highlight>>): void;
  bumpShake(): void;
  later(fn: () => void, ms: number): void;
  unlock(): void;
  bad(): void;
  good(): void;
};

export function runMateMiss(ctx: MateMissCtx) {
  ctx.bad();
  const backSoon = (msg: string) =>
    ctx.later(() => {
      ctx.setPosition(ctx.resetBoard.slice());
      ctx.bumpShake();
      ctx.unlock();
      ctx.setChips([]);
      ctx.setCoachTap(null);
      ctx.setStatus(msg + ctx.extraNudge);
    }, 500);

  const res = classifyMateMiss(ctx.next);

  if (res.kind === "no-check") {
    ctx.setStatus("Look at the black king… is he even in <strong>check</strong> after that?");
    ctx.setChips([
      {
        label: "No, he isn’t!",
        onPick: () =>
          backSoon("Right! Checkmate always starts with CHECK. Find a move that shouts check!"),
      },
      {
        label: "Hmm, yes?",
        onPick: () => backSoon("Peek again — nothing attacks him. First job: give CHECK!"),
      },
    ]);
    return;
  }

  if (res.kind === "escape") {
    const escapes = res.escapes;
    let miss = 0;
    ctx.setStatus(
      "It IS check — but the king wriggles free! <strong>Tap the square</strong> where he can escape.",
    );
    ctx.setChips([]);
    ctx.setCoachTap((t) => {
      if (escapes.includes(t)) {
        ctx.setCoachTap(null);
        ctx.setHighlights({ [t]: "hint" });
        ctx.good();
        backSoon("Exactly! Your next move must lock that door too. Go!");
      } else if (++miss >= 2) {
        ctx.setCoachTap(null);
        ctx.setHighlights(Object.fromEntries(escapes.map((s) => [s, "hint" as Highlight])));
        backSoon("There — the glowing doors! Find a move that locks them all.");
      } else {
        ctx.bad();
        ctx.setStatus(
          "Not that one — watch the king himself. Where can <strong>he</strong> step? Tap it.",
        );
      }
    });
    return;
  }

  backSoon(
    "It’s check and the king is stuck — but black can <strong>capture or block</strong> your attacker. Sneaky! Try another move.",
  );
}
