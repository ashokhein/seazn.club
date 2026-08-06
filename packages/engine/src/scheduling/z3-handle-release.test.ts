// Every WASM handle this package takes out is handed back.
//
// THIS IS A SOURCE SCAN, and it is one deliberately. A leaked `Z3_model` is
// invisible from every value the solvers return: the board, the metrics, the
// status and `rlimitSpent` are all identical either way, and the damage arrives
// later and somewhere else — `rlimitCount`'s own comment in `build.ts` records
// a leaked `Z3_stats` corrupting the heap and aborting a probe inside
// `smt::relevancy_propagator_imp::pop`, at the next `solver.pop()` rather than
// anywhere near the leak. There is no behavioural assertion to write, so the
// alternative to this file is no coverage at all.
//
// `ModelImpl` and `StatisticsImpl` share one FinalizationRegistry, so the model
// handles here are the same class of object at a comparable rate: one per `sat`
// verdict, across four tier walks and every LNS sub-solve.
//
// MUTATION-VERIFIED: deleting `m.release()` from `withModel` reds the first
// case; deleting `model.release()` from `repair.ts` reds the second.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/** The file's CODE, with comment lines dropped.
 *
 *  Every file here explains its own handle discipline in prose, so a scan over
 *  the raw text counts the explanation as a call site: the first draft of the
 *  third case below read `stats: 2` for `build.ts` off one `solver.statistics()`
 *  and one mention of it in `rlimitCount`'s doc comment. An assertion a comment
 *  can satisfy is an assertion about nothing. */
const read = (name: string): string =>
  readFileSync(new URL(`./${name}`, import.meta.url), "utf8")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

describe("no z3 handle is left to the finaliser", () => {
  // Model handles taken out, against model handles handed back. `stats.release()`
  // is excluded because the third case below owns that pairing, and counting it
  // here would let a released statistic stand in for a leaked model.
  //
  // A COUNT, NOT A SHAPE. An earlier draft pinned `withModel`'s layout with a
  // regex over `const m = …` / `try {` / `} finally {` / `m.release()`, which
  // made a prettier reflow or renaming the local red a correct file — an
  // assertion about the formatter, not about the handle discipline. What is
  // load-bearing is that the two counts agree; what is knowingly NOT covered
  // either way is whether the release sits in a `finally`, which no source scan
  // can distinguish from a release on the happy path alone.
  const handles = (src: string): { models: number; released: number } => ({
    models: (src.match(/solver\.model\(\)/g) ?? []).length,
    released: (src.match(/(?<!stats)\.release\(\);/g) ?? []).length,
  });

  it("build.ts reads a model only through the releasing helper", () => {
    // Exactly one place takes a model out. The inline
    // `model.slotOf(solver.model())` this file was written against — there were
    // two of them — would show up as extra occurrences with no release beside
    // them.
    expect(handles(read("build.ts"))).toEqual({ models: 1, released: 1 });
  });

  it("repair.ts releases the model it reads a solution out of", () => {
    expect(handles(read("repair.ts"))).toEqual({ models: 1, released: 1 });
  });

  it("every statistics() read is paired with a release", () => {
    // The precedent, and the reason the two above exist. Kept in the same file
    // so a future reader finds one rule rather than two conventions.
    for (const name of ["build.ts", "repair.ts", "build-encode.ts"]) {
      const src = read(name);
      const stats = (src.match(/\.statistics\(\)/g) ?? []).length;
      const released = (src.match(/stats\.release\(\)/g) ?? []).length;
      expect({ name, stats, released }).toEqual({ name, stats, released: stats });
    }
  });
});
