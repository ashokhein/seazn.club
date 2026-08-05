// The divisions paywall names its invisible cause (#376 part D, task 8).
//
// Since V354 an archived division with recorded results keeps its
// `divisions.per_competition.max` slot. The console hides archived divisions,
// so an org can be looking at ONE division and a "you are at your limit"
// gate — arithmetic that is simply wrong from the reader's side, with no way
// to discover why short of contacting support.
//
// This drives the wizard's real submit path with a mocked transport, makes the
// server refuse with the 402 the server actually sends, and asserts the
// explaining sentence appears — and that it appears ONLY when there is
// something archived to explain, and ONLY for this feature key. An
// explanation attached to a refusal it does not explain is a wrong answer,
// not a redundant one.
import { describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import uiEn from "@/dictionaries/en/ui.json";

const { apiV1Mock } = vi.hoisted(() => ({ apiV1Mock: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));

// `useMsg` falls back to the English catalog outside a provider; `useLocale`
// THROWS there, and the harness has no context to give it.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

const SPORTS: SportOption[] = [
  { key: "generic", name: "Generic", variants: [{ key: "score", name: "Score", system: true }] },
];

const NOTE = uiEn["division.limit.archivedCount"];

/** The 402 the API actually returns: `PaymentRequiredError` serialises to code
 *  PAYMENT_REQUIRED with the refused key in `extra.feature_key`, which is the
 *  only thing the wizard has to key its copy on. */
function paymentRequired(featureKey: string) {
  return new ApiV1Error("Upgrade required", 402, "PAYMENT_REQUIRED", {
    feature_key: featureKey,
  });
}

function mount(archivedSlotHolders: number) {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
    archivedSlotHolders,
  });
}

function button(h: ReturnType<typeof mount>, label: string) {
  const el = h.tree().find((e) => e.type === "button" && textOf(e) === label);
  if (!el) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  return el;
}

/** Found by PROP, not by scraping markup: React serialises an omitted prop as
 *  `"$undefined"`, so a string probe for `data-archived-slot-note` would match
 *  in both states and every negative case below would be vacuous. */
function notes(h: ReturnType<typeof mount>) {
  return h.tree().filter((el) => propsOf(el)["data-archived-slot-note"] !== undefined);
}

/** Name → Scheduling tab → Create, the way the organiser gets there. */
async function submitFromWizard(h: ReturnType<typeof mount>) {
  const nameInput = h
    .tree()
    .find(
      (e) =>
        e.type === "input" &&
        propsOf(e).placeholder === uiEn["wizard.divisionNamePlaceholder"],
    );
  if (!nameInput) throw new Error("name input not found");
  (propsOf(nameInput).onChange as (e: unknown) => void)({ target: { value: "Open" } });

  (propsOf(button(h, uiEn["wizard.tab.scheduling"])).onClick as () => void)();
  (propsOf(button(h, uiEn["wizard.create"])).onClick as () => void)();
  // The Create handler is `() => void submit()`, so there is no promise to
  // await — flush the queue instead.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the divisions paywall explains the archived slots holding the limit", () => {
  it("names the invisible cause when the competition holds archived slots", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(paymentRequired("divisions.per_competition.max"));

    const h = mount(1);
    await submitFromWizard(h);

    expect(notes(h)).toHaveLength(1);
    expect(textOf(notes(h)[0])).toBe(NOTE);
    expect(h.text()).toContain(NOTE);
  });

  // The org that has archived nothing is refused for an ordinary reason. It
  // must not be told to go looking for divisions that do not exist.
  it("stays quiet when nothing archived is holding a slot", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(paymentRequired("divisions.per_competition.max"));

    const h = mount(0);
    await submitFromWizard(h);

    expect(notes(h)).toHaveLength(0);
    expect(h.text()).not.toContain(NOTE);
  });

  // A different 402 on the same page (the wizard's schedule seed is Pro) is
  // not about divisions at all.
  it("stays quiet for a 402 on some other feature key", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(paymentRequired("scheduling.constraints"));

    const h = mount(3);
    await submitFromWizard(h);

    expect(notes(h)).toHaveLength(0);
    expect(h.text()).not.toContain(NOTE);
  });

  // Before any refusal there is nothing to explain — the sentence must not sit
  // on the wizard as ambient copy.
  it("stays quiet until the create is actually refused", () => {
    apiV1Mock.mockReset();

    const h = mount(2);

    expect(notes(h)).toHaveLength(0);
    expect(h.text()).not.toContain(NOTE);
  });

  // The gate itself must survive: this task adds a sentence beside the
  // paywall, it does not replace it.
  it("still renders the upgrade gate for the refused key", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(paymentRequired("divisions.per_competition.max"));

    const h = mount(1);
    await submitFromWizard(h);

    const gates = h
      .tree()
      .filter((el) => propsOf(el).feature === "divisions.per_competition.max");
    expect(gates).toHaveLength(1);
  });
});
