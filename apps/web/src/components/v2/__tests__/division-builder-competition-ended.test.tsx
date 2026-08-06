// The create wizard localises the "this competition is finished" refusal
// (#376 branch, part D).
//
// `createDivision` now 409s with COMPETITION_ENDED on a terminal competition.
// The builder's catch had exactly two arms — PAYMENT_REQUIRED, and "show
// `err.message`" — and the server's message is hardcoded English, so without
// the new arm a French organiser is shown an English sentence. This drives the
// real submit path with a mocked transport and asserts the rendered error is
// the DICTIONARY string.
//
// The mocked wire message shares NO substring with the dictionary sentence on
// purpose: the real server text is that sentence minus its full stop, so a
// `toContain(wireMessage)` written against the real string would be satisfied
// by the dictionary copy too and the negative assertion would be vacuous. What
// is under test is the code → key mapping, not the server's wording.
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

// `useMsg` already falls back to the English catalog outside a provider;
// `useLocale` THROWS there, and the harness has no context to give it.
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client-v1")>()),
  apiV1: apiV1Mock,
}));

const WIRE_MESSAGE = "raw wire text an organiser must never be shown";

const SPORTS: SportOption[] = [
  { key: "generic", name: "Generic", variants: [{ key: "score", name: "Score", system: true }] },
];

function mount() {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: SPORTS,
    constraintsAllowed: true,
  });
}

function button(h: ReturnType<typeof mount>, label: string) {
  const el = h.tree().find((e) => e.type === "button" && textOf(e) === label);
  if (!el) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  return el;
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

describe("the create wizard localises a finished-competition refusal", () => {
  it("shows the dictionary sentence, not the server's English message", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(new ApiV1Error(WIRE_MESSAGE, 409, "COMPETITION_ENDED"));

    const h = mount();
    await submitFromWizard(h);

    expect(h.text()).toContain(uiEn["division.create.competitionEnded"]);
    expect(h.text()).not.toContain(WIRE_MESSAGE);
  });

  // The arm this one must not have eaten: an unrelated refusal still shows the
  // server's own message rather than being swallowed into the new copy.
  it("still shows the server message for an unrelated failure", async () => {
    apiV1Mock.mockReset();
    apiV1Mock.mockRejectedValue(new ApiV1Error(WIRE_MESSAGE, 409, "CONFLICT"));

    const h = mount();
    await submitFromWizard(h);

    expect(h.text()).toContain(WIRE_MESSAGE);
    expect(h.text()).not.toContain(uiEn["division.create.competitionEnded"]);
  });
});
