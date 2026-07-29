// The picker that decides WHICH divisions a joint run covers (#350 §9).
//
// Two server rules it has to keep the organiser out of, rather than let them
// discover as an error after they have committed:
//   * a division with nothing movable is dropped before the run is quoted
//     (ruling R6), so it is never a thing you can pay to include;
//   * fewer than two solvable divisions is 400 AI_PLAN_SINGLE_DIVISION — zod
//     deliberately does NOT enforce it (`division_ids` is .min(1)), so the
//     board is the only place this can be a shape instead of a failure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Dict } from "@/lib/i18n-constants";
import { DictProvider } from "@/components/i18n/dict-provider";
import en from "@/dictionaries/en/ui.json";
import {
  AiDivisionPicker,
  defaultSelectedDivisionIds,
  jointRunReady,
  selectableDivisions,
  type PickerDivision,
} from "../ai-division-picker";

const dict = en as unknown as Dict;
const enText = en as unknown as Record<string, string>;

function tEn(key: string, vars?: Record<string, string | number>): string {
  const raw = enText[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (m, n) => (n in vars ? String(vars[n]) : m)) : raw;
}

// DIFFERENT movable counts on purpose: a list where every row holds the same
// number cannot tell "each row shows its own" from "every row shows the first".
const DIVISIONS: PickerDivision[] = [
  { id: "d1", name: "Under 12s", movable: 6 },
  { id: "d2", name: "Under 14s", movable: 21 },
  { id: "d3", name: "Under 16s", movable: 0 },
];

function render(selected: string[], divisions = DIVISIONS): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <AiDivisionPicker
        divisions={divisions}
        selected={selected}
        onChange={() => {}}
        msg={(k, v) => tEn(k as string, v)}
        busy={false}
      />
    </DictProvider>,
  );
}

describe("division selection rules", () => {
  it("offers only the divisions with something to place, and defaults to all of them", () => {
    expect(selectableDivisions(DIVISIONS).map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(defaultSelectedDivisionIds(DIVISIONS)).toEqual(["d1", "d2"]);
  });

  it("counts distinct divisions, not array entries, for the two-division rule", () => {
    // The orchestrator de-duplicates before it counts, so [d, d] is ONE
    // division and a joint run of it would be a single-division run at joint
    // (discounted) pricing.
    expect(jointRunReady(["d1"])).toBe(false);
    expect(jointRunReady(["d1", "d1"])).toBe(false);
    expect(jointRunReady(["d1", "d2"])).toBe(true);
  });
});

describe("AiDivisionPicker", () => {
  it("shows each division's own count and disables the one with nothing to place", () => {
    const html = render(["d1", "d2"]);
    expect(html).toContain("Under 12s");
    expect(html).toContain("Under 14s");
    expect(html).toContain("Under 16s");
    // Own counts, not the first row's.
    expect(html).toContain("6 fixtures to place");
    expect(html).toContain("21 fixtures to place");
    expect(html).toContain(enText["board.ai.picker.nothingToPlace"]);
    const rows = [...html.matchAll(/<input[^>]*data-division-id="(\w+)"[^>]*>/g)].map((m) => ({
      id: m[1],
      disabled: /disabled/.test(m[0]),
      checked: /checked/.test(m[0]),
    }));
    expect(rows).toEqual([
      { id: "d1", disabled: false, checked: true },
      { id: "d2", disabled: false, checked: true },
      { id: "d3", disabled: true, checked: false },
    ]);
  });

  it("says what to do when fewer than two divisions are picked", () => {
    const hint = enText["board.ai.picker.needTwo"];
    // The contrast matters: a hint that is always rendered would satisfy a bare
    // "contains" assertion on the one-selected case.
    expect(render(["d1", "d2"])).not.toContain(hint);
    expect(render(["d1"])).toContain(hint);
    expect(render([])).toContain(hint);
  });
});
