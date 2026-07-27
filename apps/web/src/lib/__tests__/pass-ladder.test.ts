// The Event Pass rung ladder (v17 #294, spec A7).
//
// This is the data half of the M/L picker: the two rungs, in order, each with
// the price the buyer is quoted and the caps that are the WHOLE reason to pick
// one over the other. It is pure so the numbers can be pinned without Postgres;
// the caps themselves are read live from `plan_entitlements` by the upgrade page
// and handed in, exactly as the comparison table on that page reads them.
//
// What these tests protect: a rung whose advertised price came from the OTHER
// rung's price point. That is invisible on the page (both are plausible dollar
// amounts) and invisible to the charge (the charge resolves
// `plans.stripe_price_id_onetime` by key), so the only place it can be caught is
// here, comparing the two.
import { describe, expect, it } from "vitest";
import {
  PASS_RUNG_NAME_KEY,
  PASS_RUNG_SIZE_KEY,
  passCheckoutErrorKey,
  passLadderOptions,
} from "../pass-ladder";
import { PASS_KEYS } from "@/lib/currency";

const CAPS = {
  event_pass: { entrants: 128, divisions: 10 },
  event_pass_l: { entrants: null, divisions: 20 },
} as const;

describe("passLadderOptions", () => {
  it("returns M first, then L, priced from stripe-plans.json with the caller's caps", () => {
    const options = passLadderOptions("usd", CAPS);
    expect(options.map((o) => o.key)).toEqual(["event_pass", "event_pass_l"]);
    expect(options[0]).toMatchObject({
      amountMinor: 2900,
      entrants: 128,
      divisions: 10,
      credits: 25,
    });
    expect(options[1]).toMatchObject({
      amountMinor: 5900,
      entrants: null,
      divisions: 20,
      credits: 25,
    });
  });

  it("prices in the requested currency", () => {
    const options = passLadderOptions("gbp", CAPS);
    expect(options[0]!.amountMinor).toBe(2500);
    expect(options[1]!.amountMinor).toBe(4900);
  });

  it("never quotes the same amount for both rungs, in any supported currency", () => {
    // The failure this exists for: a rung that silently reads the other rung's
    // price point. Asserted as a joined string so the reporter NAMES the
    // currency — `toEqual([])` on an array of currencies elides the contents.
    const same = (["usd", "eur", "gbp", "inr", "aud"] as const).filter((c) => {
      const [m, l] = passLadderOptions(c, CAPS);
      return m!.amountMinor === l!.amountMinor;
    });
    expect(same.join(", ")).toBe("");
  });

  it("carries the SAME credit grant on both rungs", () => {
    // PASS_CREDIT_GRANT is flat by decision (v17 #294): L buys a bigger
    // competition, not more credits. A rung-scaled grant would have to be a
    // deliberate product change, not a helper that quietly multiplied.
    const [m, l] = passLadderOptions("usd", CAPS);
    expect(l!.credits).toBe(m!.credits);
  });
});

describe("rung label maps", () => {
  it("name and size every rung the product can sell, with no key reused", () => {
    // A rung added to PASS_KEYS without a label here renders the raw plan key
    // on the ticket. tsc catches the omission; this catches the subtler slip —
    // two rungs pointing at ONE key, which labels L as M on a $59 purchase.
    for (const map of [PASS_RUNG_NAME_KEY, PASS_RUNG_SIZE_KEY]) {
      expect(PASS_KEYS.filter((k) => !map[k]).join(", ")).toBe("");
      expect(new Set(Object.values(map)).size).toBe(PASS_KEYS.length);
    }
  });
});

describe("passCheckoutErrorKey", () => {
  // The buyer must never read the server's own words: they are hardcoded
  // English in a four-locale UI, and lib/http.ts returns a RAW `err.message`
  // on an unexpected 500 — a Stripe or Postgres exception string one throw away
  // from being rendered as purchase advice.
  it("tells a buyer to try the other size when a rung has no synced price (503)", () => {
    expect(passCheckoutErrorKey(503)).toBe("upgrade.buyError.rung");
  });

  it("treats every other refusal as a stale page, not as a bad rung", () => {
    // The route 400s for five different reasons — already holds a pass, plan
    // now covers it, no active org, competition gone, rung not in PASS_KEYS —
    // and 401/404 add two more. They differ in cause and NOT in remedy.
    for (const status of [400, 401, 402, 404, 409, 429]) {
      expect(passCheckoutErrorKey(status)).toBe("upgrade.buyError.stale");
    }
  });

  it("says nothing it does not know for a 5xx, a rejected fetch or a missing secret", () => {
    for (const status of [500, 502, 504, null]) {
      expect(passCheckoutErrorKey(status)).toBe("upgrade.buyError.generic");
    }
  });
});
