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
//
// The second describe closes the other half (#376 part C review): the warning
// was added ABOVE a confirm dialog that went on promising the opposite, so a
// reader who opened the dialog met both sentences in one glance. The body copy
// now forks on the same prop the warning does.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
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

/** The archive confirm dialog's body copy, read exactly.
 *
 *  `renderIsland` renders ONE component deep, so `ConfirmDialog` sits in the
 *  tree as an unexpanded element whose `children` were already built by the
 *  danger zone's own render — the body is therefore readable without opening
 *  the dialog, and reading it as a STRING (rather than probing `h.text()` for
 *  a phrase) is what makes `toBe` able to fail when the wrong sentence is
 *  chosen. Found by `confirmLabel` because there are two dialogs here and
 *  their titles are interpolated with the division name. */
function archiveDialogBody(h: ReturnType<typeof mount>): string {
  const dialog = h
    .tree()
    .find((el) => propsOf(el).confirmLabel === uiEn["danger.archiveConfirm"]);
  if (!dialog) throw new Error("archive confirm dialog not found");
  return textOf(propsOf(dialog).children as ReactNode);
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

describe("the archive dialog says the same thing as the warning above it", () => {
  it("tells a slot-holding division its slot does not come back", () => {
    expect(archiveDialogBody(mount(true))).toBe(uiEn["danger.archiveBodySlotHeld"]);
  });

  // The approved copy for the case people actually hit — the unplayed division
  // archived by mistake — must not churn: for it, "stops counting against your
  // plan" is simply true.
  it("keeps the reassuring wording when archiving is free", () => {
    expect(archiveDialogBody(mount(false))).toBe(uiEn["danger.archiveBody"]);
  });

  it("keeps it for a caller that has not been taught the question", () => {
    expect(archiveDialogBody(mount(undefined))).toBe(uiEn["danger.archiveBody"]);
  });

  // The contradiction itself. Before this fix BOTH sentences rendered in the
  // held state: an amber line saying the slot will not be freed, directly above
  // a dialog promising the division "stops counting against your plan".
  it("never promises the plan stops counting a division it just warned about", () => {
    const h = mount(true);

    expect(h.text()).toContain(uiEn["division.archive.slotWarning"]);
    expect(h.text()).not.toContain(uiEn["danger.archiveBody"]);
    expect(h.text()).toContain(uiEn["danger.archiveBodySlotHeld"]);
  });

  // The mirror: the free case must not inherit the held case's sentence.
  it("does not warn about a slot when none is held", () => {
    const h = mount(false);

    expect(h.text()).not.toContain(uiEn["danger.archiveBodySlotHeld"]);
    expect(h.text()).toContain(uiEn["danger.archiveBody"]);
  });
});
