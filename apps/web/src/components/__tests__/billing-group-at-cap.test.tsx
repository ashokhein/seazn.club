// The FULL-bill sentence, read off the rendered panel (v17 gap #293, review
// round 1).
//
// `lib/__tests__/billing-group-view.test.ts` pins which KEY `groupView` picks,
// and a source scan pins that the panel passes it through. Neither reads the
// sentence a payer actually sees, and this panel's own header used to say it
// could not be render-tested — true when it was written, false since
// `_hook-harness.tsx` landed this wave. So this drives the real island: state,
// effect, fetch, English catalog, output tree.
//
// What that adds over the two pins: the interpolated `{max}` (a key that
// renders "covers {max} organisations" passes both of them), and the fact that
// the sentence appears at all in the branch the payer reaches — the panel could
// choose the right key and render it inside a branch nobody hits.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "./_hook-harness";
import type { ViewGroup } from "@/lib/billing-group-view";

// `useConfirm` THROWS outside its provider by design ("useConfirm needs
// <ConfirmProvider> in the tree"), and the harness's useContext returns the
// context default — which is that null. Replacing just this one export is the
// seam; everything else in the panel runs for real. (`useMsg` needs no such
// help: it falls back to the English catalog outside a DictProvider, which is
// the production path and the reason the sentences below are the shipped ones.)
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const { BillingGroupPanel } = await import("../billing-group-panel");

const ME = "user-me";

const group = (over: Partial<ViewGroup> = {}): ViewGroup => ({
  id: "grp-1",
  plan_key: "pro",
  status: "active",
  quantity_paid: 2,
  max_orgs: 2,
  has_live_subscription: true,
  orgs: [
    {
      id: "o1",
      name: "Riverside FC",
      slug: "riverside",
      status: "active",
      owner_user_id: ME,
      owner_name: "Me",
    },
    {
      id: "o2",
      name: "Northside FC",
      slug: "northside",
      status: "active",
      owner_user_id: ME,
      owner_name: "Me",
    },
  ],
  ...over,
});

/** Both endpoints the panel fetches on mount, in whatever order it asks. */
function stubFetch(groups: ViewGroup[]) {
  const json = (body: unknown) => Promise.resolve({ json: () => Promise.resolve(body) });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.includes("/transfer")
        ? json({ ok: true, data: [] })
        : json({ ok: true, data: groups }),
    ),
  );
}

/** Render and wait for the mount effect's fetch to land — the panel returns
 *  `null` until then, so an assertion taken synchronously would be vacuous. */
async function panelText(groups: ViewGroup[]): Promise<string> {
  stubFetch(groups);
  const island = renderIsland(BillingGroupPanel, {
    subscriptionId: "grp-1",
    currentUserId: ME,
  });
  await vi.waitFor(() => expect(island.text()).toContain("On this bill"));
  return island.text();
}

afterEach(() => vi.unstubAllGlobals());

describe("the sentence a payer reads when the bill is full", () => {
  it("sends a Pro payer to the Add-ons tab, with the cap interpolated", async () => {
    const text = await panelText([group({ plan_key: "pro" })]);
    expect(text).toContain("This plan covers 2 organisations, and they are all in use.");
    expect(text).toContain("Buy an extra organisation from Settings → Add-ons");
    // The cadence claim is the only money claim either sentence makes, and it
    // is the one that is true in every currency and on both intervals.
    expect(text).toContain("billed monthly on top of your current bill");
    // Not the old remedy, which for this payer is a wrong turn: changing plan
    // when what they need is a $9 rider.
    expect(text).not.toContain("Upgrade to cover more");
  });

  it("still tells a Community payer to upgrade", async () => {
    // The discriminator. Without it, a panel that rendered the add-on sentence
    // unconditionally would pass the test above — and Community would be sold a
    // rider it cannot buy.
    const text = await panelText([
      group({ plan_key: "community", max_orgs: 1, has_live_subscription: false }),
    ]);
    expect(text).toContain("This plan covers 1 organisations, and they are all in use.");
    expect(text).toContain("Upgrade to cover more");
    expect(text).not.toContain("Settings → Add-ons");
  });

  it("says neither sentence while the bill still has room", async () => {
    // The third state, and the reason `atCap` and `atCapKey` stay separate: the
    // key is always computed, so a panel that rendered it unconditionally would
    // tell a payer with a spare slot that they had none.
    const text = await panelText([group({ max_orgs: 5 })]);
    expect(text).not.toContain("they are all in use");
    // ...and it offers the real control instead of an explanation.
    expect(text).toContain("Add an organisation");
  });
});
