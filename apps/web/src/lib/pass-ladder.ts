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
import { passPrice, type Currency, type PassKey } from "@/lib/currency";
import { PASS_CREDIT_GRANT } from "@/lib/pricing-cards";
import type { DictionaryKey } from "@/lib/i18n-keys";

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
 * Which localised sentence a failed checkout gets, from the HTTP status alone.
 *
 * The buyer must never be shown the server's own text. Every message
 * `/api/billing/pass-checkout` can emit is hardcoded English inside a
 * four-locale product, and `lib/http.ts`'s catch-all hands back a raw
 * `err.message` on an unexpected 500 — so a Stripe or Postgres exception string
 * is one unhandled throw away from being rendered to a buyer as purchase
 * advice. Mapping on status makes that structurally impossible.
 *
 * Three buckets, and the middle one is deliberately NOT narrowed to "bad rung":
 *
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
  if (status === 503) return "upgrade.buyError.rung";
  if (status !== null && status >= 400 && status < 500) return "upgrade.buyError.stale";
  return "upgrade.buyError.generic";
}

