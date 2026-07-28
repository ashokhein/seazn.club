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
// The SAME predicate the create-org picker's "buy another slot" link is gated
// on, deliberately not a second `["pro", "pro_plus"]` written into this file:
// two copies of "which plans sell a rider" drift, and the drift is invisible
// because each side is individually correct. Client-safe (it reads the shared
// stripe-plans.json seed), unlike `lib/org-addons.ts` which imports server-only.
import { planSellsExtraOrg } from "@/lib/org-addon-plans";

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
  /**
   * Which sentence a FULL bill reads — and the remedy it names is not the same
   * one for everybody (v17 gap #293).
   *
   * "Upgrade to cover more" was true before the extra-organisation rider
   * shipped. On Pro and Pro Plus it is now wrong: the remedy is a $9/$19
   * monthly rider bought from Settings → Add-ons, and sending a paying customer
   * to change their plan when they need an add-on is a worse dead end than
   * saying nothing. Community genuinely must upgrade first — it sells no rider
   * — so this SPLITS rather than trying to be one sentence that is right for
   * nobody in particular.
   *
   * Gated on `has_live_subscription` too, mirroring the create-org picker's
   * link: a recurring rider needs an existing subscription to ride, so a comped
   * or never-paid group on a Pro plan would be sent to an Add-ons tab that can
   * only answer with a notice.
   *
   * Neither string states a RATE. The plan's per-organisation tier and the
   * rider SKU agree monthly and diverge annually (~37%), so any figure here
   * would be wrong for annual groups; the Add-ons page, which knows the
   * currency and reads the SKU, is the one place that quotes it.
   */
  atCapKey: MessageKey;
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
  /** Offers made TO the current user (any group) — a bill someone wants to
   *  hand them. Shown wherever this panel renders so it is never missed. */
  incoming: ViewOffer[];
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
  // Offers made TO this user, for ANY group — "someone wants to hand you their
  // bill". Not scoped to subscriptionId: the recipient does not own the group
  // being offered, so it would never match theirs.
  const incoming = offers.filter((o) => o.direction === "made_to_me");

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
    outgoing.length === 0 &&
    incoming.length === 0;

  return {
    onBill,
    seatsPaid,
    freeSlots,
    atCap,
    atCapKey:
      planSellsExtraOrg(group.plan_key) && group.has_live_subscription
        ? "billing.group.atCapAddOn"
        : "billing.group.atCap",
    hasLive: group.has_live_subscription,
    candidates,
    blocked,
    recipients,
    outgoing,
    incoming,
    hidden,
  };
}

/**
 * Which confirm body an ATTACH shows. The price is stated before the click,
 * always — a control that spends money without saying so is the one thing this
 * panel must not be.
 *
 * THREE bodies, not two (v17 gap #299 round 4). `freeSlots` alone cannot tell
 * the trial case from the charged one, and it fails CLOSED-WRONG:
 * `syncGroupQuantity` deliberately freezes `quantity_paid` while trialing, so
 * `freeSlots = max(0, quantity_paid - onBill)` is **0** during a trial and the
 * two-way version handed a trialing payer the CHARGED body. On that path
 * `raising` is false (`&& !trialing`), `proration_behavior` is `"none"` and
 * `previewAttachCharge` returns null at `:123` — nothing is prorated at all, so
 * "added to your next invoice" was as false as the "charged now" it replaced.
 * `groups.md` said the opposite two sections away, which is how it surfaced:
 * two surfaces of one product contradicting each other on the first thing a new
 * group does.
 *
 * `trialing` is therefore checked FIRST and independently of `freeSlots`.
 * Ordering matters: a trialing group with a freed slot is still on the trial
 * path, and the trial is the more specific truth.
 */
export function attachConfirmKey(freeSlots: number, trialing = false): MessageKey {
  if (trialing) return "billing.group.attach.confirmTrial";
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
