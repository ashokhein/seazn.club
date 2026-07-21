// What the billing-group panel DECIDES, separated from what it draws.
//
// The panel is a client component whose data arrives in an effect, and this
// repo's vitest environment is `node` with no jsdom — so a render test would
// mount it, run no effect, and assert against the `null` it returns before its
// data lands. That test would pass whatever this logic did.
//
// The logic is worth more than the markup anyway. It decides which of two
// confirm bodies a payer reads immediately before an irreversible act, and one
// of those pairs has already been wrong once: the transfer dialog promised
// "nothing changes until they add a card, and you can withdraw at any time" for
// a group with no live subscription, where the handover is immediate and there
// is nothing to withdraw. That was caught by looking at a screenshot, which is
// not a control that runs on every change. These functions are.
//
// The key functions return MessageKey rather than string, so a typo fails the
// build instead of rendering a raw dotted key into a confirm dialog.
import type { MessageKey } from "@/lib/messages";

export interface ViewGroupOrg {
  id: string;
  name: string;
  slug: string;
  status: string;
  /** Null when the org has lost its owner member — it still bills and still
   *  shows, it just cannot receive the group. */
  owner_user_id: string | null;
  owner_name: string | null;
}

export interface ViewGroup {
  id: string;
  plan_key: string;
  status: string;
  quantity_paid: number;
  max_orgs: number | null;
  has_live_subscription: boolean;
  orgs: ViewGroupOrg[];
}

export interface ViewOffer {
  setup_intent_id: string;
  subscription_id: string;
  client_secret: string | null;
  to_user_id: string | null;
  expires_at: number | null;
  direction: "made_by_me" | "made_to_me";
}

export interface Recipient {
  id: string;
  name: string | null;
  /** The organisation that makes them eligible, shown so the payer can tell two
   *  people of the same name apart. */
  via: string;
}

export interface GroupView {
  /** Organisations currently on the bill. */
  onBill: number;
  /** Seats already paid for. NOT the same number as `onBill`, and never merged
   *  with it: a slot that has been paid for and freed stays yours until
   *  renewal, so "4 of 5" would price a free re-add as a purchase. */
  seatsPaid: number;
  /** Paid-for slots with no organisation in them. The only case where adding an
   *  organisation genuinely costs nothing. */
  freeSlots: number;
  atCap: boolean;
  hasLive: boolean;
  /** Organisations in the payer's OTHER groups that can actually move onto this
   *  bill. Carries the group each came from. */
  candidates: (ViewGroupOrg & { from: ViewGroup })[];
  /** Organisations the payer owns that CANNOT move yet, because they still pay
   *  for a live subscription of their own. Listed rather than hidden — see
   *  `groupView`. */
  blocked: (ViewGroupOrg & { from: ViewGroup })[];
  /** Who this bill could be handed to. */
  recipients: Recipient[];
  /** Live offers this payer has made on THIS group. */
  outgoing: ViewOffer[];
  /** True when the panel has no story to tell and should not render. */
  hidden: boolean;
}

/**
 * Everything the panel needs, derived from the two payloads it fetches.
 *
 * Returns `null` only when the named group is absent from the listing — the
 * caller renders nothing, because a payer looking at a bill that is not theirs
 * is a routing accident, not a state to explain.
 */
export function groupView(args: {
  groups: ViewGroup[];
  offers: ViewOffer[];
  subscriptionId: string;
  currentUserId: string;
}): GroupView | null {
  const { groups, offers, subscriptionId, currentUserId } = args;
  const group = groups.find((g) => g.id === subscriptionId);
  if (!group) return null;

  // Organisations sitting in this payer's OTHER groups. An org in a group
  // somebody else pays for is not listed and could not be attached anyway —
  // attach requires the actor to own both sides.
  const elsewhere = groups
    .filter((g) => g.id !== subscriptionId)
    .flatMap((g) => g.orgs.map((o) => ({ ...o, from: g })));

  // An organisation that still pays for a LIVE subscription of its own cannot
  // join: attachOrgToGroup refuses it with a 409, because Stripe cannot move
  // credit between customers and refunding an annual plan mid-term could be
  // $130+. It must cancel its own subscription first.
  //
  // Offering it anyway was worse than a dead button: the payer clicked it, read
  // a confirm dialog promising "your bill goes up by half your plan's rate —
  // charged now", agreed to that, and only then got an error. The refusal is a
  // rule, not a failure, so it belongs on the screen before the click.
  //
  // Listed rather than filtered away, because silence reads as a bug — the
  // payer knows they own the organisation and would go looking for why it is
  // missing. The sentence beside it is the one thing that would have saved the
  // trip.
  const candidates = elsewhere.filter((o) => !o.from.has_live_subscription);
  const blocked = elsewhere.filter((o) => o.from.has_live_subscription);

  const onBill = group.orgs.length;
  const seatsPaid = group.quantity_paid;
  const freeSlots = Math.max(0, seatsPaid - onBill);
  const atCap = group.max_orgs !== null && onBill >= group.max_orgs;

  // The owners of the organisations already on the bill, minus the payer
  // themselves (a self-transfer 400s) and minus organisations whose owner
  // member is gone. Deduped: one person owning three clubs in the group is one
  // candidate, not three.
  //
  // Someone OUTSIDE the group is reachable in two steps rather than not at all:
  // invite them into one of these organisations and hand them that
  // organisation's ownership, which is separate from billing and needs the
  // current org owner to act. Both sides have then consented before money moves.
  //
  // FIRST org wins the `via` label. Deduping through `new Map(entries)` gives
  // last-wins, so a person owning three clubs was labelled with whichever
  // happened to sort last while the list directly above showed the first — the
  // label exists to disambiguate two people, and one that disagrees with the
  // list on screen does the opposite.
  const byOwner = new Map<string, Recipient>();
  for (const o of group.orgs) {
    if (!o.owner_user_id || o.owner_user_id === currentUserId) continue;
    if (byOwner.has(o.owner_user_id)) continue;
    byOwner.set(o.owner_user_id, { id: o.owner_user_id, name: o.owner_name, via: o.name });
  }
  const recipients = [...byOwner.values()];

  const outgoing = offers.filter(
    (o) => o.direction === "made_by_me" && o.subscription_id === subscriptionId,
  );

  // A solo organisation with nothing to add and nothing paid ahead has no
  // grouping story, and a panel saying "On this bill: 1" on every Community
  // account is noise. It appears the moment any of these becomes true, which is
  // also the moment it starts being useful. An outstanding offer counts: it is a
  // live claim on the subscription and must stay withdrawable even on a group
  // of one.
  // `blocked` counts here too: an organisation the payer owns but cannot move
  // yet is precisely the case that needs explaining, and hiding the panel would
  // leave them with no way to find out why.
  const hidden =
    onBill <= 1 &&
    candidates.length === 0 &&
    blocked.length === 0 &&
    freeSlots === 0 &&
    outgoing.length === 0;

  return {
    onBill,
    seatsPaid,
    freeSlots,
    atCap,
    hasLive: group.has_live_subscription,
    candidates,
    blocked,
    recipients,
    outgoing,
    hidden,
  };
}

/**
 * Which confirm body an ATTACH shows. The price is stated before the click,
 * always: attaching charges immediately unless a paid slot is free, and a
 * control that spends money without saying so is the one thing this panel must
 * not be.
 */
export function attachConfirmKey(freeSlots: number): MessageKey {
  return freeSlots > 0
    ? "billing.group.attach.confirmFree"
    : "billing.group.attach.confirmCharge";
}

/**
 * Which confirm body a TRANSFER shows — two different promises, because two
 * different things happen.
 *
 * With a live subscription the recipient must confirm a card first and the
 * payer can withdraw until they do. With nothing to bill there is no invoice to
 * fail, so the handover happens on the spot; telling that payer "nothing
 * changes until they add a card" would be a plain lie, and it is the copy they
 * read immediately before losing the group.
 */
export function transferConfirmKey(hasLive: boolean): MessageKey {
  return hasLive
    ? "billing.group.transfer.confirmBody"
    : "billing.group.transfer.confirmBodyImmediate";
}

/** The explainer above the recipient picker, matched to the same two cases. */
export function transferExplainerKey(hasLive: boolean): MessageKey {
  return hasLive
    ? "billing.group.transfer.explainer"
    : "billing.group.transfer.explainerImmediate";
}
