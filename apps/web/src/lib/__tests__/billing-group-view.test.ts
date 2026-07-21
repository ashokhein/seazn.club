// The billing-group panel's decisions (V310). This is the copy and the
// arithmetic a payer reads immediately before spending money or giving a
// subscription away, so every branch is pinned here rather than left to a
// screenshot someone remembers to look at.
import { describe, expect, it } from "vitest";
import {
  attachConfirmKey,
  groupView,
  transferConfirmKey,
  transferExplainerKey,
  type ViewGroup,
  type ViewGroupOrg,
  type ViewOffer,
} from "@/lib/billing-group-view";

const ME = "user-me";

function org(over: Partial<ViewGroupOrg> = {}): ViewGroupOrg {
  return {
    id: over.id ?? "org-1",
    name: over.name ?? "Riverside FC",
    slug: over.slug ?? "riverside",
    status: over.status ?? "active",
    owner_user_id: over.owner_user_id === undefined ? ME : over.owner_user_id,
    owner_name: over.owner_name === undefined ? "Me" : over.owner_name,
  };
}

function group(over: Partial<ViewGroup> = {}): ViewGroup {
  return {
    id: over.id ?? "grp-1",
    plan_key: over.plan_key ?? "pro",
    status: over.status ?? "active",
    quantity_paid: over.quantity_paid ?? 1,
    max_orgs: over.max_orgs === undefined ? null : over.max_orgs,
    has_live_subscription: over.has_live_subscription ?? true,
    orgs: over.orgs ?? [org()],
  };
}

function offer(over: Partial<ViewOffer> = {}): ViewOffer {
  return {
    setup_intent_id: over.setup_intent_id ?? "seti_1",
    subscription_id: over.subscription_id ?? "grp-1",
    client_secret: over.client_secret ?? null,
    to_user_id: over.to_user_id === undefined ? "user-heir" : over.to_user_id,
    expires_at: over.expires_at ?? null,
    direction: over.direction ?? "made_by_me",
  };
}

function view(groups: ViewGroup[], offers: ViewOffer[] = [], subscriptionId = "grp-1") {
  return groupView({ groups, offers, subscriptionId, currentUserId: ME });
}

describe("the two counts", () => {
  // The single most important property of this panel. Seats paid and orgs on
  // the bill are DIFFERENT numbers, and merging them into "4 of 5" would price
  // a free re-add as a purchase — the opposite of what the customer was told.
  it("keeps seats paid and orgs on the bill as separate numbers", () => {
    const v = view([group({ quantity_paid: 5, orgs: [org({ id: "a" }), org({ id: "b" })] })])!;
    expect(v.onBill).toBe(2);
    expect(v.seatsPaid).toBe(5);
    expect(v.freeSlots).toBe(3);
  });

  it("reports no free slots when the bill is exactly full", () => {
    const v = view([group({ quantity_paid: 2, orgs: [org({ id: "a" }), org({ id: "b" })] })])!;
    expect(v.freeSlots).toBe(0);
  });

  // quantity_paid is only written once Stripe CONFIRMS the item, so a group
  // that has never synced sits at 0 with live orgs on it. That is a real
  // resting state (a failed sync the reconcile sweep will correct), and it must
  // read as "nothing paid ahead", never as free capacity.
  it("treats a never-synced group as having no free slots, not free capacity", () => {
    const v = view([group({ quantity_paid: 0, orgs: [org({ id: "a" })] })])!;
    expect(v.freeSlots).toBe(0);
    expect(attachConfirmKey(v.freeSlots)).toBe("billing.group.attach.confirmCharge");
  });

  // An EMPTY group with seats still paid for: every org detached mid-period.
  // The slots remain the customer's until renewal, which is the whole promise
  // behind "removing an org frees a slot you can reuse at no charge".
  it("still counts the paid slots of a group every org has left", () => {
    const v = view([group({ quantity_paid: 3, orgs: [] })])!;
    expect(v.onBill).toBe(0);
    expect(v.freeSlots).toBe(3);
    expect(attachConfirmKey(v.freeSlots)).toBe("billing.group.attach.confirmFree");
  });

  // Drift the other way: more live orgs than Stripe has been told about, which
  // is exactly the state the reconcile sweep exists to correct. The panel must
  // not render a NEGATIVE free-slot count while that is being fixed, and must
  // never offer the "costs nothing" copy on the strength of it.
  it("floors free slots at zero when more orgs are live than seats were paid for", () => {
    const v = view([
      group({ quantity_paid: 1, orgs: [org({ id: "a" }), org({ id: "b" }), org({ id: "c" })] }),
    ])!;
    expect(v.freeSlots).toBe(0);
    expect(attachConfirmKey(v.freeSlots)).toBe("billing.group.attach.confirmCharge");
  });
});

describe("the cap", () => {
  it("is not at cap below the limit, and is at cap on it", () => {
    expect(view([group({ max_orgs: 3, orgs: [org({ id: "a" }), org({ id: "b" })] })])!.atCap).toBe(
      false,
    );
    expect(
      view([group({ max_orgs: 2, orgs: [org({ id: "a" }), org({ id: "b" })] })])!.atCap,
    ).toBe(true);
  });

  // An org count OVER the cap is reachable: a staff downgrade moves the whole
  // group to a smaller plan without evicting anyone. Reading `> max` instead of
  // `>= max` would then reopen the add control on an over-full bill.
  it("stays at cap when the group is already over it after a downgrade", () => {
    const v = view([
      group({ max_orgs: 1, orgs: [org({ id: "a" }), org({ id: "b" }), org({ id: "c" })] }),
    ])!;
    expect(v.atCap).toBe(true);
  });

  // null is unlimited, not zero. Treating it as a number would make every
  // group at cap and hide the add control from the plans that most need it.
  it("is never at cap when the plan has no limit", () => {
    const v = view([
      group({ max_orgs: null, orgs: Array.from({ length: 40 }, (_, i) => org({ id: `o${i}` })) }),
    ])!;
    expect(v.atCap).toBe(false);
  });

  // A cap of 1 is the Community plan, where a solo org is ALREADY at cap. The
  // add control must be closed, not open with a charge attached.
  it("is at cap for a solo org on a one-org plan", () => {
    expect(view([group({ max_orgs: 1, orgs: [org()] })])!.atCap).toBe(true);
  });

  // The conflict worth being explicit about: a paid slot going spare does NOT
  // buy a way past the plan's cap. The two are independent, and the panel shows
  // the cap message rather than a free-of-charge add it would then have to
  // refuse server-side.
  it("stays at cap even with a paid slot free — a spare seat is not extra capacity", () => {
    const v = view([
      group({ max_orgs: 2, quantity_paid: 5, orgs: [org({ id: "a" }), org({ id: "b" })] }),
    ])!;
    expect(v.atCap).toBe(true);
    expect(v.freeSlots).toBe(3);
  });
});

// A group an org can actually move OUT of: Community, nothing live to refund.
// `group()` defaults to a live subscription, which is the payer's OWN bill —
// a source group that looks like that is one attach would refuse.
function communityGroup(over: Partial<ViewGroup> = {}): ViewGroup {
  return group({ plan_key: "community", has_live_subscription: false, ...over });
}

describe("candidates to add", () => {
  it("offers the orgs in the payer's other groups, and never one already on this bill", () => {
    const v = view([
      group({ id: "grp-1", orgs: [org({ id: "here" })] }),
      communityGroup({ id: "grp-2", orgs: [org({ id: "there", name: "Northside" })] }),
    ])!;
    expect(v.candidates.map((c) => c.id)).toEqual(["there"]);
    // The source group travels with the candidate — the panel needs it, and it
    // is where a wrong `from` would silently attach the wrong org.
    expect(v.candidates[0].from.id).toBe("grp-2");
  });

  it("has none when the payer owns only this one group", () => {
    expect(view([group()])!.candidates).toEqual([]);
  });

  // A payer with several groups is the normal shape AFTER a detach, so the
  // flatten across groups is not an edge case — and each candidate has to keep
  // its own source group, since attach is called with it.
  it("flattens every org across every other group, each keeping its own source", () => {
    const v = view([
      group({ id: "grp-1", orgs: [org({ id: "here" })] }),
      communityGroup({ id: "grp-2", orgs: [org({ id: "a" }), org({ id: "b" })] }),
      communityGroup({ id: "grp-3", orgs: [org({ id: "c" })] }),
    ])!;
    expect(v.candidates.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(v.candidates.map((c) => c.from.id)).toEqual(["grp-2", "grp-2", "grp-3"]);
  });

  // attachOrgToGroup refuses an org that still pays for a live subscription
  // (409): Stripe cannot move credit between customers, and refunding an annual
  // plan mid-term could be $130+. Offering it anyway meant the payer agreed to
  // "your bill goes up by half your plan's rate — charged now" and THEN got an
  // error, which is the worst possible order for those two events.
  it("does not offer an organisation that still pays for its own subscription", () => {
    const v = view([
      group({ id: "grp-1", orgs: [org({ id: "here" })] }),
      group({ id: "grp-2", has_live_subscription: true, orgs: [org({ id: "paying" })] }),
    ])!;
    expect(v.candidates).toEqual([]);
    expect(v.blocked.map((b) => b.id)).toEqual(["paying"]);
  });

  it("splits a mixed set, offering only the ones that can actually move", () => {
    const v = view([
      group({ id: "grp-1", orgs: [org({ id: "here" })] }),
      communityGroup({ id: "grp-2", orgs: [org({ id: "free" })] }),
      group({ id: "grp-3", has_live_subscription: true, orgs: [org({ id: "paying" })] }),
    ])!;
    expect(v.candidates.map((c) => c.id)).toEqual(["free"]);
    expect(v.blocked.map((b) => b.id)).toEqual(["paying"]);
  });

  // A cancelled group keeps its Stripe id for ever, so presence is not
  // liveness. Its orgs are billing nothing and CAN move.
  it("offers an org whose old group is cancelled, not merely present in Stripe", () => {
    const v = view([
      group({ id: "grp-1", orgs: [org({ id: "here" })] }),
      group({
        id: "grp-2",
        status: "canceled",
        has_live_subscription: false,
        orgs: [org({ id: "lapsed" })],
      }),
    ])!;
    expect(v.candidates.map((c) => c.id)).toEqual(["lapsed"]);
    expect(v.blocked).toEqual([]);
  });

  // The panel must not vanish on the one payer who most needs the explanation:
  // a solo bill whose only other org is blocked has no candidates, no freed
  // slots and no offers, which is precisely the old `hidden` predicate.
  it("stays visible for a solo bill whose only other organisation is blocked", () => {
    const v = view([
      group({ id: "grp-1", quantity_paid: 1, orgs: [org({ id: "here" })] }),
      group({ id: "grp-2", has_live_subscription: true, orgs: [org({ id: "paying" })] }),
    ])!;
    expect(v.hidden).toBe(false);
  });

  // An empty group of the payer's own — every org detached, subscription not
  // yet cancelled. It contributes no candidates and must not produce an
  // undefined entry in the picker.
  it("contributes nothing from an empty other group", () => {
    const v = view([
      group({ id: "grp-1", orgs: [org({ id: "here" })] }),
      group({ id: "grp-2", orgs: [] }),
    ])!;
    expect(v.candidates).toEqual([]);
  });
});

describe("who the bill can be handed to", () => {
  it("lists the owners of the orgs on the bill, excluding the payer themselves", () => {
    // A self-transfer 400s server-side; offering it would be a control that
    // exists only to fail.
    const v = view([
      group({
        orgs: [
          org({ id: "a", owner_user_id: ME, owner_name: "Me" }),
          org({ id: "b", name: "Northside", owner_user_id: "u2", owner_name: "Sam" }),
        ],
      }),
    ])!;
    expect(v.recipients).toEqual([{ id: "u2", name: "Sam", via: "Northside" }]);
  });

  it("counts one person owning three clubs as ONE recipient", () => {
    const v = view([
      group({
        orgs: [
          org({ id: "a", name: "A", owner_user_id: "u2", owner_name: "Sam" }),
          org({ id: "b", name: "B", owner_user_id: "u2", owner_name: "Sam" }),
          org({ id: "c", name: "C", owner_user_id: "u2", owner_name: "Sam" }),
        ],
      }),
    ])!;
    expect(v.recipients).toHaveLength(1);
    // First org wins the "via" label, matching the list order the payer sees.
    expect(v.recipients[0].via).toBe("A");
  });

  // An org whose owner member has left still BILLS and still shows in the list;
  // it simply cannot receive the group. Including it would put an undeletable
  // null-id button in the picker.
  it("skips an org that has lost its owner member", () => {
    const v = view([
      group({
        orgs: [
          org({ id: "a" }),
          org({ id: "b", owner_user_id: null, owner_name: null }),
        ],
      }),
    ])!;
    expect(v.recipients).toEqual([]);
  });

  // A missing display name must not remove someone from the picker — the panel
  // has its own fallback label. Dropping them would make the bill
  // untransferable for a data reason the payer cannot see or fix.
  it("keeps a recipient whose display name is missing", () => {
    const v = view([
      group({
        orgs: [
          org({ id: "a" }),
          org({ id: "b", name: "Northside", owner_user_id: "u2", owner_name: null }),
        ],
      }),
    ])!;
    expect(v.recipients).toEqual([{ id: "u2", name: null, via: "Northside" }]);
  });

  // The payer owns every org on the bill: there is genuinely nobody to hand it
  // to. The panel shows the "invite them first" empty state rather than an
  // empty picker, so this must be an empty list and not a near-miss.
  it("has nobody to offer to when the payer owns every org on the bill", () => {
    const v = view([
      group({ orgs: [org({ id: "a" }), org({ id: "b" }), org({ id: "c" })] }),
    ])!;
    expect(v.recipients).toEqual([]);
  });

  // Suspension is MODERATION, not billing: the slot is still paid for and the
  // org still bills. Its owner stays a valid recipient — dropping them would
  // make a bill untransferable because one club was suspended.
  it("keeps the owner of a suspended org as a recipient", () => {
    const v = view([
      group({
        orgs: [
          org({ id: "a" }),
          org({
            id: "b",
            name: "Northside",
            status: "suspended",
            owner_user_id: "u2",
            owner_name: "Sam",
          }),
        ],
      }),
    ])!;
    expect(v.recipients).toEqual([{ id: "u2", name: "Sam", via: "Northside" }]);
  });

  // Two different people, both eligible: the picker must offer both, and the
  // `via` label is what tells them apart.
  it("offers two distinct owners separately", () => {
    const v = view([
      group({
        orgs: [
          org({ id: "a" }),
          org({ id: "b", name: "Northside", owner_user_id: "u2", owner_name: "Sam" }),
          org({ id: "c", name: "Eastvale", owner_user_id: "u3", owner_name: "Sam" }),
        ],
      }),
    ])!;
    expect(v.recipients).toEqual([
      { id: "u2", name: "Sam", via: "Northside" },
      { id: "u3", name: "Sam", via: "Eastvale" },
    ]);
  });
});

describe("outstanding offers", () => {
  it("shows only the offers this payer made on THIS group", () => {
    const v = view(
      [group({ id: "grp-1", orgs: [org({ id: "a" }), org({ id: "b" })] })],
      [
        offer({ setup_intent_id: "mine", subscription_id: "grp-1", direction: "made_by_me" }),
        // Another group of the payer's — belongs on that group's panel, not here.
        offer({ setup_intent_id: "other-group", subscription_id: "grp-9" }),
        // An offer made TO this user is somebody else's group being handed over;
        // rendering it here would put a Withdraw button on an offer they cannot
        // withdraw.
        offer({ setup_intent_id: "incoming", subscription_id: "grp-1", direction: "made_to_me" }),
      ],
    )!;
    expect(v.outgoing.map((o) => o.setup_intent_id)).toEqual(["mine"]);
  });

  it("has none when the payer has made no offer", () => {
    expect(view([group({ orgs: [org({ id: "a" }), org({ id: "b" })] })], [])!.outgoing).toEqual([]);
  });

  // V311's partial unique index allows at most one PENDING offer per group, so
  // this should not happen — but the view is a renderer, not the invariant. If
  // the database is ever wrong, showing both withdrawable is the recoverable
  // outcome; silently rendering one leaves a live claim the payer cannot see.
  it("renders every outgoing offer it is given rather than assuming there is one", () => {
    const v = view(
      [group({ orgs: [org({ id: "a" }), org({ id: "b" })] })],
      [offer({ setup_intent_id: "one" }), offer({ setup_intent_id: "two" })],
    )!;
    expect(v.outgoing.map((o) => o.setup_intent_id)).toEqual(["one", "two"]);
  });

  // The recipient left the group after being offered it. The offer row survives
  // (it references users, not membership), so it stays withdrawable — the panel
  // falls back to a generic name. The view's job is to keep the offer, not to
  // drop it for want of a label.
  it("keeps an offer whose recipient is no longer among the group's owners", () => {
    const v = view(
      [group({ orgs: [org({ id: "a" }), org({ id: "b" })] })],
      [offer({ to_user_id: "u-departed" })],
    )!;
    expect(v.outgoing).toHaveLength(1);
    expect(v.recipients.map((r) => r.id)).not.toContain("u-departed");
  });
});

describe("when the panel hides itself", () => {
  // A panel saying "On this bill: 1" on every Community account is noise.
  it("hides for a solo org with nothing paid ahead and nothing to add", () => {
    expect(view([group({ quantity_paid: 1, orgs: [org()] })])!.hidden).toBe(true);
  });

  it("appears once a second org is on the bill", () => {
    expect(
      view([group({ quantity_paid: 2, orgs: [org({ id: "a" }), org({ id: "b" })] })])!.hidden,
    ).toBe(false);
  });

  it("appears for a solo org with a paid slot going spare — that slot is the story", () => {
    expect(view([group({ quantity_paid: 3, orgs: [org()] })])!.hidden).toBe(false);
  });

  it("appears for a solo org when the payer has another org they could move in", () => {
    expect(
      view([
        group({ id: "grp-1", orgs: [org({ id: "a" })] }),
        group({ id: "grp-2", orgs: [org({ id: "b" })] }),
      ])!.hidden,
    ).toBe(false);
  });

  // The one that is easy to get wrong. An outstanding offer is a LIVE CLAIM on
  // the subscription, so it must stay withdrawable even on a group of one —
  // otherwise the payer has given someone a seven-day claim on their bill with
  // no way to take it back.
  it("appears for a solo org with an outstanding offer, so it can be withdrawn", () => {
    const v = view([group({ quantity_paid: 1, orgs: [org()] })], [offer()])!;
    expect(v.hidden).toBe(false);
    expect(v.outgoing).toHaveLength(1);
  });

  // An empty group with nothing paid ahead and nothing to move in: the
  // subscription is on its way out. Nothing useful to say, so nothing shown.
  it("hides an empty group with no paid slots and no offer", () => {
    expect(view([group({ quantity_paid: 0, orgs: [] })])!.hidden).toBe(true);
  });

  it("appears for an empty group that still has paid slots to reuse", () => {
    expect(view([group({ quantity_paid: 2, orgs: [] })])!.hidden).toBe(false);
  });

  it("returns null when the named group is not one of the payer's", () => {
    expect(view([group({ id: "grp-1" })], [], "grp-not-mine")).toBeNull();
  });

  // Distinct from `hidden`: an absent group means the caller was pointed at a
  // bill that is not the payer's, which is a routing accident rather than a
  // state to explain. Conflating the two would render an empty panel there.
  it("returns null rather than a hidden view when there are no groups at all", () => {
    expect(view([], [])).toBeNull();
  });
});

describe("what the confirm dialog promises", () => {
  it("says an attach is free only when a paid slot is actually free", () => {
    expect(attachConfirmKey(1)).toBe("billing.group.attach.confirmFree");
    expect(attachConfirmKey(0)).toBe("billing.group.attach.confirmCharge");
  });

  // This pair has been wrong once. With no live subscription there is nothing
  // to bill, so the handover is IMMEDIATE — promising "nothing changes until
  // they add a card, and you can withdraw at any time" would be a lie told to
  // the payer in the moment they lose the group.
  it("does not promise a two-phase handover when the transfer is immediate", () => {
    expect(transferConfirmKey(true)).toBe("billing.group.transfer.confirmBody");
    expect(transferConfirmKey(false)).toBe("billing.group.transfer.confirmBodyImmediate");
  });

  it("matches the picker's explainer to the same two cases", () => {
    expect(transferExplainerKey(true)).toBe("billing.group.transfer.explainer");
    expect(transferExplainerKey(false)).toBe("billing.group.transfer.explainerImmediate");
  });

  // The explainer and the confirm body must never disagree: reading "they must
  // add a card first" and then confirming a dialog that hands the group over on
  // the spot is worse than either message alone being wrong.
  it("never pairs the immediate explainer with the two-phase confirm body", () => {
    for (const hasLive of [true, false]) {
      const immediateExplainer = transferExplainerKey(hasLive).endsWith("Immediate");
      const immediateBody = transferConfirmKey(hasLive).endsWith("Immediate");
      expect(immediateExplainer).toBe(immediateBody);
    }
  });
});
