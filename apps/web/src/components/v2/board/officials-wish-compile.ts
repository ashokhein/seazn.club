// Officials wish → instruction compiler (v4 Task 14, design/v4/03 §3). The
// officials step's chip pickers assemble an OfficialsWish[]; this flattens it
// into the sentence(s) that seed the officials instruction textarea — the
// Phase B sibling of wish-compile.ts.
//
// IMPORTANT: the compiled text is ENGLISH ONLY, on purpose, in every UI locale
// (same rule as wish-compile.ts). It is the instruction sent to the officials
// LLM prompt, not copy the organiser reads — the model reasons in English and
// the golden prompts are English. The chip LABELS and pickers ARE localized
// (board.ai.officials.wish.* catalog); only this compiled output stays English.
//
// Pure and React-free so it is unit-tested in isolation.

export type OfficialsWish =
  | { kind: "senior_finals" }
  | { kind: "spread_even" }
  | { kind: "only_window"; officialId: string; officialName: string; edge: "before" | "after"; time: string };

export type OfficialsWishKind = OfficialsWish["kind"];

/** One English sentence per wish (terse, period-terminated so the join is clean). */
function sentence(w: OfficialsWish): string {
  switch (w.kind) {
    case "senior_finals":
      return "Put senior referees on the finals.";
    case "spread_even":
      return "Spread officiating duties evenly across the roster.";
    case "only_window":
      return `Only assign ${w.officialName} to matches ${w.edge} ${w.time}.`;
  }
}

/** Compile officials wishes into a single space-joined English instruction
 *  fragment. Empty in → empty out (the textarea shows nothing with no chips). */
export function compileOfficialsWishes(wishes: OfficialsWish[]): string {
  return wishes.map(sentence).join(" ");
}
