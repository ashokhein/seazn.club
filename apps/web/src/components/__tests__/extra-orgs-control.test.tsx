// The Extra organisations control (v17 gap #293, SPEC-6 §A5) — the wave's
// buyer-facing money surface.
//
// WHY THIS FILE EXISTS. `extraOrgsErrorKey` is pinned as a MAP by
// lib/__tests__/extra-orgs-copy.test.ts, and the route's four refusals are
// pinned by extra-org-addon.test.ts. Neither witnesses the one line where the
// two meet. Replacing `extraOrgsErrorKey(failedStatus)` with a literal generic
// key collapses 409 ("change plan"), 422 ("change the number") and 423 ("move
// an organisation out") into "That didn't work. Try again." — three different
// customer actions become one shrug — and every other suite in the repo stays
// green, as does `tsc`. The same is true of the server floor: swapping
// `parsed >= min` for `parsed >= 0` silently un-bounds the stepper.
//
// Screenshots are evidence for a moment. This is the regression test.
//
// Rendered with the `environment: "node"` hook harness (./_hook-harness) —
// the same one pass-upgrade.test.tsx uses, for the same reason.
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import { ExtraOrgsControl } from "@/components/extra-orgs-control";
import { propsOf, renderIsland, textOf } from "./_hook-harness";
import type { Dict, Locale } from "@/lib/i18n-constants";
// The REAL dictionary, not a stub: `t()` returns the KEY on a miss, so these
// assertions also fail if a key the control needs was never added to en/ui.json.
import ui from "@/dictionaries/en/ui.json";

// Mocked at the MODULE: the control calls `postJson` directly, so this is the
// only place a spy can sit on the real path from the click to the POST.
vi.mock("@/lib/api-post", () => ({ postJson: vi.fn() }));
import { postJson } from "@/lib/api-post";

const dict = ui as Dict;
const post = vi.mocked(postJson);

function mount(overrides: Partial<Parameters<typeof ExtraOrgsControl>[0]> = {}) {
  return renderIsland(ExtraOrgsControl, {
    initialCount: 1,
    min: 0,
    max: 50,
    priceMinor: 900,
    currency: "usd" as const,
    dict,
    locale: "en" as Locale,
    ...overrides,
  });
}

type Island = ReturnType<typeof mount>;
const find = (island: Island, pred: (p: Record<string, unknown>) => boolean) =>
  island.tree().find((el) => pred(propsOf(el)));

const byLabel = (island: Island, label: string) =>
  find(island, (p) => p["aria-label"] === label);
const plus = (island: Island) => byLabel(island, "Increase extra organisations")!;
const minus = (island: Island) => byLabel(island, "Decrease extra organisations")!;
const input = (island: Island) => find(island, (p) => "data-extra-org-count" in p)!;
const errorEl = (island: Island) => find(island, (p) => "data-extra-org-error" in p);
const savedEl = (island: Island) => find(island, (p) => "data-extra-org-saved" in p);
const saveBtn = (island: Island) =>
  island.tree().find((el) => textOf(el as ReactElement) === "Save");

const click = (el: ReactElement) => (propsOf(el).onClick as () => void)();
const type = (island: Island, value: string) =>
  (propsOf(input(island)).onChange as (e: { target: { value: string } }) => void)({
    target: { value },
  });
const save = async (island: Island) =>
  (propsOf(saveBtn(island)!).onClick as () => unknown)();

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ ok: true, data: { extraOrgs: 2 } });
});

describe("ExtraOrgsControl — a refusal keeps its own remedy", () => {
  /** Drive one real failure end to end and read what the buyer is shown. */
  async function refusalText(status: number | null): Promise<string> {
    const island = mount();
    click(plus(island));
    post.mockResolvedValue({ ok: false, status, error: "SERVER ENGLISH", body: {} });
    await save(island);
    return textOf(errorEl(island)!);
  }

  it("shows THREE DIFFERENT sentences for the three different actions", async () => {
    const planChange = await refusalText(409);
    const differentNumber = await refusalText(422);
    const moveAnOrgOut = await refusalText(423);

    // The assertion the whole feature turns on. A literal key in place of
    // `extraOrgsErrorKey(failedStatus)` makes all three identical.
    expect(new Set([planChange, differentNumber, moveAnOrgOut]).size).toBe(3);

    // And each is the RIGHT one — distinctness alone would survive a shuffle.
    expect(planChange).toBe(
      "This billing group can't hold extra organisations. Move to Pro or Pro Plus first.",
    );
    expect(differentNumber).toBe("Choose a whole number between 0 and 50.");
    expect(moveAnOrgOut).toBe(
      "Organisations in this group are using the extra organisations you're removing. " +
        "Move one out of the group first.",
    );
  });

  it("does not send a stale-org-cookie 400 to the 'fix your number' copy", async () => {
    expect(await refusalText(400)).not.toBe(await refusalText(422));
    expect(await refusalText(400)).toBe(
      "Pick an organisation again — the one this page opened with is no longer selected.",
    );
  });

  it("says nothing confident about a 500 or a rejected fetch", async () => {
    expect(await refusalText(500)).toBe("That didn't work. Try again.");
    expect(await refusalText(null)).toBe("That didn't work. Try again.");
  });

  it("NEVER renders the server's own English", async () => {
    // lib/http.ts lets a raw `err.message` out on an unexpected 500, and every
    // message this route produces is hardcoded English written for logs.
    for (const status of [400, 401, 403, 409, 422, 423, 503, 500, null]) {
      expect(await refusalText(status)).not.toContain("SERVER ENGLISH");
    }
  });

  it("shows no error at all until something has failed", () => {
    // The positive discriminator for every absence above: if the error node
    // rendered unconditionally, the assertions would still pass.
    const island = mount();
    expect(errorEl(island)).toBeUndefined();
    expect(savedEl(island)).toBeUndefined();
  });
});

describe("ExtraOrgsControl — the server's floor bounds the control", () => {
  it("will not let the stepper go below `min`", () => {
    const island = mount({ initialCount: 2, min: 2 });
    // Disabled at the floor, so 423 is a backstop rather than the first thing
    // the customer meets.
    expect(propsOf(minus(island)).disabled).toBe(true);
    click(minus(island));
    expect(propsOf(input(island)).value).toBe("2");
  });

  it("refuses a TYPED number below the floor, and offers no Save for it", () => {
    const island = mount({ initialCount: 2, min: 2 });
    type(island, "1");
    // `parsed >= 0` in place of `parsed >= min` makes 1 valid, which turns the
    // control into a request the server will refuse with 423.
    expect(saveBtn(island)).toBeUndefined();
    expect(island.text()).toContain("Choose a whole number between 2 and 50.");
  });

  it("refuses a number above `max`", () => {
    const island = mount({ max: 50 });
    type(island, "51");
    expect(saveBtn(island)).toBeUndefined();
    expect(propsOf(plus(island)).disabled).toBe(false);
  });

  it("still allows a raise from the floor — the bound is one-directional", () => {
    // Discriminator for the two absences above: a control that never offers
    // Save would pass both of them.
    const island = mount({ initialCount: 2, min: 2 });
    click(plus(island));
    expect(saveBtn(island)).toBeDefined();
    expect(propsOf(input(island)).value).toBe("3");
  });
});

describe("ExtraOrgsControl — what the buyer is quoted and what is sent", () => {
  it("names the rider subtotal as the riders' cost, not as the whole bill", () => {
    // The customer is on a $19/mo plan; 3 riders is $27 of RIDERS and $46 of
    // bill. An unqualified "New total: $27 per month" next to a Save button is
    // a wrong number at the moment of commitment.
    const island = mount({ initialCount: 2, priceMinor: 900 });
    click(plus(island));
    expect(island.text()).toContain("New total for extra organisations: $27 per month");
    expect(island.text()).not.toContain("New total: $27 per month");
  });

  it("quotes the per-rider rate it was given, in the given currency", () => {
    expect(mount({ priceMinor: 1600, currency: "gbp" }).text()).toContain("£16 each per month");
  });

  it("warns that a RAISE is prorated and a CUT is not refunded", () => {
    const up = mount({ initialCount: 1, min: 0 });
    click(plus(up));
    expect(up.text()).toContain("You'll pay the difference for the rest of this billing period.");

    const down = mount({ initialCount: 2, min: 0 });
    click(minus(down));
    expect(down.text()).toContain("Takes effect now. There's no refund");
  });

  it("posts the TOTAL the group should hold, never a delta", async () => {
    // `count` is a total; sending a delta would let two saves double a bill.
    const island = mount({ initialCount: 2 });
    click(plus(island));
    click(plus(island));
    await save(island);
    expect(post).toHaveBeenCalledWith("/api/billing/extra-orgs", { count: 4 });
  });

  it("confirms a save and keeps the new number, because the webhook lags", async () => {
    // org_addons is written by customer.subscription.updated, so re-reading the
    // page now would show the OLD count. The control keeps its own baseline;
    // if it did not, a successful save would look unsaved.
    const island = mount({ initialCount: 1 });
    click(plus(island));
    await save(island);
    expect(savedEl(island)).toBeDefined();
    expect(errorEl(island)).toBeUndefined();
    expect(saveBtn(island)).toBeUndefined(); // no longer dirty
    expect(propsOf(input(island)).value).toBe("2");
  });

  it("clears a previous failure when the buyer changes the number again", async () => {
    const island = mount();
    click(plus(island));
    post.mockResolvedValue({ ok: false, status: 423, error: "x", body: {} });
    await save(island);
    expect(errorEl(island)).toBeDefined();
    click(plus(island));
    expect(errorEl(island)).toBeUndefined();
  });
});
