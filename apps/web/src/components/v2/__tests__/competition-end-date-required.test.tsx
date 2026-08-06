// #376 — the end date is mandatory at create and non-removable at edit.
//
// The schema half is pinned in api-v1/__tests__/schemas.test.ts. What no schema
// test can see is the JOIN between a form's state and the body it POSTs: both
// forms used to send `ends_on: <value> || null`, so a blank field shipped an
// explicit null. That null is now a 400, and a 400 here reads to the organiser
// as a bare "Invalid input" naming no field. So the click is the only witness
// for two things — that the body carries the date they typed, and that a
// missing or backwards one is refused in their own language before the round
// trip.
//
// vitest runs `environment: "node"` with no jsdom here, so the stateful islands
// are driven through the shared hook harness (see _hook-harness.tsx).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { CompetitionWizard } from "../competition-wizard";
import { CompetitionSettings } from "../competition-settings";
import { apiV1 } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});

// The REAL English catalog: `t()` returns the KEY on a miss, so an assertion on
// the sentence also fails if the key was never added to en/ui.json.
const enDict = uiEn as unknown as Dict;
const msg = (key: MessageKey) => t(enDict, key);
const REQUIRED = msg("comp.wizard.endsOn.required");
const BACKWARDS = msg("comp.validation.endsBeforeStarts");

const postedBody = () => {
  const call = vi.mocked(apiV1).mock.calls.at(-1);
  return (call?.[1] as { json: Record<string, unknown> }).json;
};

/** [starts, ends] — both forms render the pair in that order. */
const dateInputs = (tree: ReactElement[]) =>
  tree.filter((el) => el.type === "input" && propsOf(el).type === "date");

function typeDate(tree: ReactElement[], which: 0 | 1, value: string): void {
  const input = dateInputs(tree)[which]!;
  (propsOf(input).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

/** Fire the form's onSubmit the way a browser would. */
async function submitForm(tree: ReactElement[]): Promise<void> {
  const form = tree.find((el) => el.type === "form")!;
  await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => unknown)({
    preventDefault: () => {},
  });
}

beforeEach(() => {
  vi.mocked(apiV1).mockReset();
  vi.mocked(apiV1).mockResolvedValue({ id: "c1", slug: "summer-cup" } as never);
});

describe("CompetitionWizard — create requires an end date (#376)", () => {
  const mount = () => renderIsland(CompetitionWizard, { orgSlug: "riverside" });

  it("marks the end date required and leaves the start date optional", () => {
    const [starts, ends] = dateInputs(mount().tree());
    expect(propsOf(ends!)["aria-required"]).toBe("true");
    expect(propsOf(starts!)["aria-required"]).toBeUndefined();
  });

  it("refuses to POST at all when the end date is blank, and says why", async () => {
    const island = mount();
    typeDate(island.tree(), 0, "2026-06-01"); // a start date alone is not enough
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(REQUIRED);
  });

  it("refuses an end date before the start date, without a round trip", async () => {
    const island = mount();
    typeDate(island.tree(), 0, "2026-06-01");
    typeDate(island.tree(), 1, "2026-05-31");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(BACKWARDS);
  });

  it("POSTs the typed date itself — never `|| null`", async () => {
    const island = mount();
    typeDate(island.tree(), 0, "2026-06-01");
    typeDate(island.tree(), 1, "2026-08-31");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).toHaveBeenCalledTimes(1);
    expect(postedBody().ends_on).toBe("2026-08-31");
  });
});

describe("CompetitionSettings — the end date is changeable, not removable (#376)", () => {
  const mount = () =>
    renderIsland(CompetitionSettings, {
      competition: {
        id: "c1",
        name: "Summer Cup",
        slug: "summer-cup",
        description: null,
        starts_on: "2026-06-01",
        ends_on: "2026-08-31",
        visibility: "private",
        status: "draft",
        frozen: false,
        discoverable: false,
        discovery: {},
        branding: {},
      },
      orgId: "o1",
      canEdit: true,
      discoveryBranding: false,
    });

  it("still PATCHes a CHANGED end date", async () => {
    const island = mount();
    typeDate(island.tree(), 1, "2027-01-15");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).toHaveBeenCalledTimes(1);
    expect(postedBody().ends_on).toBe("2027-01-15");
  });

  it("refuses to PATCH a CLEARED end date — the null that reopened the lock", async () => {
    const island = mount();
    typeDate(island.tree(), 1, "");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(REQUIRED);
  });

  it("refuses to PATCH an end date moved before the start date", async () => {
    const island = mount();
    typeDate(island.tree(), 1, "2026-05-31");
    await submitForm(island.tree());

    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(island.text()).toContain(BACKWARDS);
  });
});
