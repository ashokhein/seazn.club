// The archive warning arrives BEFORE the click (#376 part D, task 8).
//
// `danger.archiveBody` — the sentence inside the confirm dialog — still says
// the division "stops counting against your plan". Since V354 that is true
// only for an UNPLAYED division; a played one keeps its
// `divisions.per_competition.max` slot forever. An org that archived a played
// division learned this from a paywall on a later create, with nothing on
// screen to connect the two.
//
// So this drives the real component and asserts the copy is rendered above the
// archive button, only when the slot is actually held.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { DivisionDangerZone } from "@/components/v2/division-danger-zone";
import uiEn from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/div",
}));

const BASE = {
  divisionId: "d1",
  divisionName: "Open",
  orgSlug: "org",
  compSlug: "comp",
};

function mount(slotHeldOnArchive?: boolean) {
  return renderIsland(DivisionDangerZone, { ...BASE, slotHeldOnArchive });
}

/** Elements carrying the marker, found by PROP rather than by scraping HTML:
 *  React serialises an omitted boolean prop into the markup as `"$undefined"`,
 *  so a string probe for `data-slot-warning` matches in both states and the
 *  negative case would be vacuous. */
function warnings(h: ReturnType<typeof mount>) {
  return h.tree().filter((el) => propsOf(el)["data-slot-warning"] !== undefined);
}

describe("the danger zone warns before an archive that costs a slot", () => {
  it("renders the slot warning when the division holds a slot", () => {
    const h = mount(true);

    expect(warnings(h)).toHaveLength(1);
    expect(textOf(warnings(h)[0])).toBe(uiEn["division.archive.slotWarning"]);
    expect(h.text()).toContain(uiEn["division.archive.slotWarning"]);
  });

  it("renders nothing when archiving is free", () => {
    const h = mount(false);

    expect(warnings(h)).toHaveLength(0);
    expect(h.text()).not.toContain(uiEn["division.archive.slotWarning"]);
  });

  // The default matters: a caller that has not been taught the question yet
  // must show no warning rather than warn everybody.
  it("says nothing when the caller passes no answer at all", () => {
    const h = mount(undefined);

    expect(warnings(h)).toHaveLength(0);
  });

  // "Before the click" is the whole point — a warning underneath the button,
  // or only inside the confirm dialog, is a warning the reader meets after
  // deciding. Position is asserted against the rendered order, not eyeballed.
  it("puts the warning above the archive button", () => {
    const h = mount(true);
    // `tree()` is already the DFS-flattened render, so index order IS the
    // order the reader meets these elements down the page.
    const flat = h.tree();
    const warningAt = flat.findIndex((el) => propsOf(el)["data-slot-warning"] !== undefined);
    const buttonAt = flat.findIndex(
      (el) => el.type === "button" && textOf(el) === uiEn["danger.archive"],
    );

    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(buttonAt).toBeGreaterThanOrEqual(0);
    expect(warningAt).toBeLessThan(buttonAt);
  });
});
