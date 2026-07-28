// The Event Pass rung ladder (v17 #294, spec A7) — the data behind the M/L
// picker on a competition's upgrade page.
//
// Pure by design. The caps are NOT queried here: the upgrade page already reads
// `plan_entitlements` once for its comparison table, and this takes those same
// values, so the picker and the table can never disagree about what L grants.
// (lib/pass-comparison.ts explains at length why no figure in this feature is
// written down in code or copy.) Prices come from `lib/currency`'s
// stripe-plans.json-backed `passPrice` for the same reason — one price list,
// the same one `stripe:sync` pushes to Stripe.
import { PASS_KEYS, passPrice, type Currency, type PassKey } from "@/lib/currency";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import type { Dict } from "@/lib/i18n-constants";
import type { DictionaryKey } from "@/lib/i18n-keys";
import { t } from "@/lib/i18n-runtime";

export interface PassRungOption {
  key: PassKey;
  /** Price in the display currency's minor units. */
  amountMinor: number;
  /** null = unlimited — `plan_entitlements`' own convention for "no ceiling". */
  entrants: number | null;
  divisions: number | null;
  /** AI credits granted on purchase. Flat across rungs by decision (#294). */
  credits: number;
}

export type PassRungCaps = Readonly<
  Record<PassKey, { entrants: number | null; divisions: number | null }>
>;

/**
 * Both rungs, M first, priced in `currency`, with the caller's live caps.
 *
 * Ordered smallest-first because that is the order the stub renders and the
 * order the buyer reads; M is also what the picker pre-selects, so the first
 * element is the default sale.
 */
export function passLadderOptions(currency: Currency, caps: PassRungCaps): PassRungOption[] {
  return (["event_pass", "event_pass_l"] as const).map((key) => ({
    key,
    amountMinor: passPrice(currency, key),
    entrants: caps[key].entrants,
    divisions: caps[key].divisions,
    credits: PASS_CREDIT_GRANT,
  }));
}

/** A rung with a price attached — the least any "which of these is cheapest"
 *  question needs to know. Structural so `PassRungOption` satisfies it too. */
export interface PricedRung {
  key: PassKey;
  amountMinor: number;
}

/**
 * The cheapest of some priced rungs, ties going to the earlier one.
 *
 * Split out from `lowestPassRung` so the CHOICE can be tested against a price
 * list where the answer is not M. Against the live seed M is cheapest in all
 * five currencies, so a "lowest" that simply returned `event_pass` would pass
 * every assertion made against the real numbers — and would keep passing on the
 * day L is discounted or a rung is added underneath.
 *
 * Ties keep ladder order because the price is quoted NEXT TO a rung name on
 * some surfaces; a coin-flip between equal amounts would flip the name.
 */
export function lowestPricedRung<T extends PricedRung>(rungs: readonly T[]): T {
  // PASS_KEYS is a non-empty `as const` tuple and every caller derives from it,
  // so there is always a first element to reduce from.
  return rungs.reduce((lowest, rung) => (rung.amountMinor < lowest.amountMinor ? rung : lowest));
}

/**
 * The rung a surface should quote when it shows ONE price for a product that
 * sells at two — "Event Pass — from $29 one-time".
 *
 * Five surfaces (the paywall, the billing-page offer, the dashboard card menu,
 * the competition header and competition settings) invite a purchase without
 * offering the choice; the choice itself lives on the upgrade page. Each of them
 * passed the literal `"event_pass"` to `passPrice`, which is honest only while M
 * is the cheapest rung — an assumption `tsc` cannot see and no test held. This
 * derives it instead, and hands back the KEY as well as the amount so a caller
 * that also names the rung cannot name a different one from the one it priced.
 */
export function lowestPassRung(currency: Currency): PricedRung {
  return lowestPricedRung(
    PASS_KEYS.map((key) => ({ key, amountMinor: passPrice(currency, key) })),
  );
}

/**
 * "Event Pass L active" — the held signal, NAMING the rung.
 *
 * The three surfaces that render it (the dashboard card's seal, the competition
 * header, competition settings) said a flat "Event Pass active": the product
 * FAMILY, with nothing beside it to say which size. That reads as M's name to an
 * org that paid $59 for L, on the only surfaces where the rung is not disclosed
 * anywhere else — the upgrade page's own stub prints `data-pass-held-rung`
 * immediately under the family name, which is why it needs no change.
 *
 * A helper rather than a `t(dict, "pass.entry.active", { rung })` at each call
 * site: `t()` renders a forgotten var as the literal `{rung}`, and three call
 * sites each remembering is three chances to ship a brace to a customer.
 */
export function passActiveLabel(dict: Dict, passKey: PassKey): string {
  return t(dict, "pass.entry.active", { rung: t(dict, PASS_RUNG_NAME_KEY[passKey]) });
}

/**
 * Both rungs' held signals, finished.
 *
 * The pages that mount `<CompetitionPassEntry>` hold the dictionary but not the
 * rung — the pass row is resolved once by the competition LAYOUT and reaches the
 * island through `CompetitionPassProvider`. So the page hands over every label
 * and the island picks the one it knows about.
 *
 * An explicit object literal, not `Object.fromEntries(PASS_KEYS.map(…))`: a
 * third rung must be a compile error here, not a card that silently falls back
 * to a missing key.
 */
export function passActiveLabels(dict: Dict): Record<PassKey, string> {
  return {
    event_pass: passActiveLabel(dict, "event_pass"),
    event_pass_l: passActiveLabel(dict, "event_pass_l"),
  };
}

/**
 * The rung's full NAME, as a dictionary key — "Event Pass L". Used where the
 * rung has to identify itself away from the ladder: the held ticket stub, the
 * comparison column.
 *
 * A `Record<PassKey, …>` rather than a ternary so a third rung added to
 * `PASS_KEYS` is a compile error here instead of a silently mislabelled ticket.
 */
export const PASS_RUNG_NAME_KEY: Record<PassKey, DictionaryKey> = {
  event_pass: "upgrade.rung.m",
  event_pass_l: "upgrade.rung.l",
};

/**
 * The rung's SIZE CODE, as a dictionary key — "M", "L". Used inside the ladder,
 * where "Event Pass" is already the name on the ticket and repeating it twice
 * per row is noise.
 *
 * Translatable despite being one letter: a locale that ships sizes in its own
 * words needs its own initials (fr Moyen/Grand → M/G), and nothing user-facing
 * in this product is allowed to be a literal in the component.
 */
export const PASS_RUNG_SIZE_KEY: Record<PassKey, DictionaryKey> = {
  event_pass: "upgrade.rung.sizeM",
  event_pass_l: "upgrade.rung.sizeL",
};

/**
 * The size code again, in the MARKETING dictionary — for `/pricing`, which
 * loads `marketing` and not `ui`, and would otherwise have to ship a second
 * dictionary to a page that needs two words from it.
 *
 * Same shape and same reason as the two maps above: a third rung is a compile
 * error here rather than a `/pricing` card that silently prices two sizes and
 * labels one.
 */
export const PASS_RUNG_MARKETING_KEY: Record<PassKey, DictionaryKey> = {
  event_pass: "pricing.pass.rung.m",
  event_pass_l: "pricing.pass.rung.l",
};

/**
 * Which localised sentence a failed checkout gets, from the HTTP status alone.
 *
 * The buyer must never be shown the server's own text. Every message
 * `/api/billing/pass-checkout` can emit is hardcoded English inside a
 * four-locale product, and `lib/http.ts`'s catch-all hands back a raw
 * `err.message` on an unexpected 500 — so a Stripe or Postgres exception string
 * is one unhandled throw away from being rendered to a buyer as purchase
 * advice. Mapping on status makes that structurally impossible.
 *
 * Four buckets, and the 4xx one is deliberately NOT narrowed to "bad rung":
 *
 *   409  a previous payment for this competition was taken and then REFUSED by
 *        the mint guard (v17 gap #326), so the sale is frozen until staff
 *        resolve it. Split out of the 4xx bucket because that bucket's whole
 *        premise — "the page is out of date, reload and try again" — is a
 *        confident lie here: reloading changes nothing, and the person reading
 *        it has already been charged. It is the one refusal on this route the
 *        buyer cannot clear by any action at all, so the copy says what
 *        happened to their money instead of asking them to retry.
 *   503  the only thing this route 503s for is a rung whose one-time price has
 *        not been `stripe:sync`'d in this environment. Unambiguous as a CAUSE,
 *        so the copy names the rung — but it says "try the other size" rather
 *        than "pick the other size", because an environment that has never been
 *        synced at all has both rungs in this state and the second one would be
 *        a second dead end.
 *   4xx  every other refusal — already holds a pass, plan now covers it, no
 *        active org, signed out, competition gone, rung not in `PASS_KEYS`.
 *        They differ in cause and NOT in remedy: each means the page was
 *        rendered against state that has since moved, and each is resolved by
 *        reloading. Telling all of them "that size isn't one we sell" would be
 *        a confident lie in five cases out of six.
 *   else 5xx, a rejected fetch, an ok body with no secret. Nothing is known;
 *        say so, and invite a retry.
 */
export function passCheckoutErrorKey(status: number | null): DictionaryKey {
  if (status === 409) return "upgrade.buyError.underReview";
  if (status === 503) return "upgrade.buyError.rung";
  if (status !== null && status >= 400 && status < 500) return "upgrade.buyError.stale";
  return "upgrade.buyError.generic";
}

