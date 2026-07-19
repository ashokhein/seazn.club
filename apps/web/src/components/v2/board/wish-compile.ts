// Wish → instruction compiler (v4 Task 12, design/v4/03 §3). The brief step's
// chip pickers assemble a Wish[]; this flattens it into the sentence(s) that
// seed the AI instruction textarea.
//
// IMPORTANT: the compiled text is ENGLISH ONLY, on purpose, in every UI locale.
// It is the instruction we send to the LLM (schedule-ai prompt), not copy the
// organiser reads — the model reasons in English and the golden prompts are
// English. The chip LABELS and pickers ARE localized (board.ai.wish.* catalog);
// only this compiled output stays English. Do not translate these strings.
//
// Pure and React-free so it is unit-tested in isolation (wish-compile.test.ts).

export type Wish =
  | { kind: "finish_by"; time: string }
  | { kind: "start_window"; target: string; targetName: string; edge: "before" | "after"; time: string }
  | { kind: "keep_apart"; aName: string; bName: string }
  | { kind: "final_last"; court: string }
  | { kind: "pin_entrant"; name: string };

/** One English sentence per wish (kept terse — every sentence ends with a period
 *  so `compileWishes` can space-join them into a clean instruction). */
function sentence(w: Wish): string {
  switch (w.kind) {
    case "finish_by":
      return `Finish by ${w.time}.`;
    case "start_window":
      return `Schedule ${w.targetName} ${w.edge} ${w.time}.`;
    case "keep_apart":
      return `Keep ${w.aName} and ${w.bName} apart.`;
    case "final_last":
      return `Put the final last on ${w.court}.`;
    case "pin_entrant":
      return `Keep ${w.name}'s existing slots.`;
  }
}

/** Compile wishes into a single space-joined English instruction fragment.
 *  Empty in → empty out (so the textarea shows nothing when no chips are set). */
export function compileWishes(wishes: Wish[]): string {
  return wishes.map(sentence).join(" ");
}

/** Join a compiled fragment and free text with one separating space, dropping
 *  either side when empty (no stray leading/trailing space). */
export function joinNonEmpty(a: string, b: string): string {
  return [a, b].filter((s) => s.length > 0).join(" ");
}

/**
 * Recover the organiser's free text from the current instruction by stripping
 * the previously-compiled prefix. Used when a chip is added/removed: the
 * compiled part re-derives while whatever was typed after it is kept. If the
 * instruction no longer starts with that prefix — the organiser edited inside
 * the compiled region — the whole thing is treated as free text: graceful, and
 * it never corrupts or drops what they wrote.
 */
export function deriveFreeText(instruction: string, prevCompiled: string): string {
  if (prevCompiled === "") return instruction;
  if (instruction.startsWith(prevCompiled)) return instruction.slice(prevCompiled.length).replace(/^\s+/, "");
  return instruction;
}
