// The RESTORE refusal names its cause too (#376 part C review).
//
// `restoreDivision` refuses on exactly the count `createDivision` refuses on:
// an archived division with recorded results keeps its
// `divisions.per_competition.max` slot (V354). So an org at a cap of four,
// with three visible divisions and two archived-and-played, clicks Restore,
// meets an upgrade gate — and the divisions it is being charged for are the
// very rows on screen, unlabelled. The wizard was taught to say this; the
// mirror surface was not.
//
// Same shape as division-builder-archived-slot-note.test.tsx: drive the real
// component through the real refusal, and assert the sentence appears ONLY
// when the archived slots are what tipped the limit over and ONLY for this
// feature key. The arithmetic behind that answer is the server's, proved
// against a real 402 in usecases/__tests__/division-slot-disclosure.test.ts.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { ArchivedDivisions } from "@/components/v2/archived-divisions";
import uiEn from "@/dictionaries/en/ui.json";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/settings",
}));

vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

const NOTE = uiEn["division.limit.archivedCount"];
const DIVISION_LIMIT = "divisions.per_competition.max";

const ARCHIVED = [
  {
    id: "d1",
    name: "Retired Open",
    sport_key: "generic",
    archived_at: "2026-01-02T00:00:00.000Z",
  },
];

/** The 402 the API actually returns for a refused restore. */
function paymentRequired(featureKey: string) {
  return new ApiV1Error("Upgrade required", 402, "PAYMENT_REQUIRED", {
    feature_key: featureKey,
  });
}

function mount(archivedSlotsExplainRefusal: boolean) {
  return renderIsland(ArchivedDivisions, {
    divisions: ARCHIVED,
    canEdit: true,
    archivedSlotsExplainRefusal,
  });
}

/** Found by PROP, not by scraping markup: React serialises an omitted prop as
 *  `"$undefined"`, so a string probe for `data-archived-slot-note` would match
 *  in both states and every negative below would be vacuous. */
function notes(h: ReturnType<typeof mount>) {
  return h.tree().filter((el) => propsOf(el)["data-archived-slot-note"] !== undefined);
}

function gates(h: ReturnType<typeof mount>) {
  return h.tree().filter((el) => propsOf(el).feature === DIVISION_LIMIT);
}

/** Click Restore on the one archived row, the way the organiser does. */
async function clickRestore(h: ReturnType<typeof mount>) {
  const button = h
    .tree()
    .find((el) => el.type === "button" && textOf(el) === uiEn["archived.restore"]);
  if (!button) throw new Error("no Restore button");
  (propsOf(button).onClick as () => void)();
  // `onClick` is `() => void restore(id)`, so there is no promise to await.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the restore refusal names the archived slots holding the limit", () => {
  it("names the invisible cause when the archived slots tipped the limit over", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(paymentRequired(DIVISION_LIMIT));

    const h = mount(true);
    await clickRestore(h);

    expect(notes(h)).toHaveLength(1);
    expect(textOf(notes(h)[0])).toBe(NOTE);
    expect(h.text()).toContain(NOTE);
  });

  // The org whose VISIBLE divisions already fill the cap would be refused with
  // or without its archived rows — pointing at them is a wrong answer, not a
  // redundant one. Same for an org that has archived nothing.
  it("stays quiet unless the archived slots are what tipped the limit over", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(paymentRequired(DIVISION_LIMIT));

    const h = mount(false);
    await clickRestore(h);

    expect(notes(h)).toHaveLength(0);
    expect(h.text()).not.toContain(NOTE);
  });

  it("stays quiet for a 402 on some other feature key", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(paymentRequired("scheduling.constraints"));

    const h = mount(true);
    await clickRestore(h);

    expect(notes(h)).toHaveLength(0);
    expect(h.text()).not.toContain(NOTE);
  });

  // An ordinary failure is not a paywall: no gate, and therefore nothing for
  // this sentence to explain.
  it("stays quiet when the restore fails for a non-billing reason", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(new ApiV1Error("registration is open", 409, "CONFLICT", {}));

    const h = mount(true);
    await clickRestore(h);

    expect(notes(h)).toHaveLength(0);
    expect(gates(h)).toHaveLength(0);
  });

  // Before any refusal there is nothing to explain — the sentence must not sit
  // on competition settings as ambient copy.
  it("stays quiet until the restore is actually refused", () => {
    apiV1Mock.mockReset();

    const h = mount(true);

    expect(notes(h)).toHaveLength(0);
    expect(h.text()).not.toContain(NOTE);
  });

  // The gate itself must survive: this adds a sentence beside the paywall, it
  // does not replace it.
  it("still renders the upgrade gate for the refused key", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(paymentRequired(DIVISION_LIMIT));

    const h = mount(true);
    await clickRestore(h);

    expect(gates(h)).toHaveLength(1);
  });
});
