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
  PASS_LOCK_REASON_KEY,
  PASS_RUNG_NAME_KEY,
  PASS_RUNG_SIZE_KEY,
  lowestPassRung,
  lowestPricedRung,
  passActiveLabel,
  passActiveLabels,
  passCheckoutErrorKey,
  passEndedReasons,
  passLadderOptions,
} from "../pass-ladder";
import { PASS_LOCK_REASONS } from "@/lib/entitlements";
import { PASS_KEYS, SUPPORTED_CURRENCIES, passPrice } from "@/lib/currency";
import uiEn from "@/dictionaries/en/ui.json";

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

describe("lowestPricedRung", () => {
  // The reducer, tested away from the seed. Against the LIVE price list M is
  // cheapest, so an implementation that simply returned "event_pass" would pass
  // every assertion in the sibling describe below — and would then quote $29
  // "from" on the day a rung is added under it, or the day L is discounted.
  it("picks the cheapest rung, whichever one that is", () => {
    const rungs = [
      { key: "event_pass", amountMinor: 9900 },
      { key: "event_pass_l", amountMinor: 1900 },
    ] as const;
    expect(lowestPricedRung(rungs).key).toBe("event_pass_l");
  });

  it("keeps the earlier rung when two are priced the same", () => {
    // Ordering is the tie-break, not chance: `passLadderOptions` renders M
    // first, and a "from" price that flipped rung between renders on equal
    // amounts would flip the NAME beside it too.
    const rungs = [
      { key: "event_pass", amountMinor: 2900 },
      { key: "event_pass_l", amountMinor: 2900 },
    ] as const;
    expect(lowestPricedRung(rungs).key).toBe("event_pass");
  });
});

describe("lowestPassRung", () => {
  // Every surface that quotes ONE number for a two-rung product ("Event Pass —
  // from $29") has to quote the floor. Before #294 they each passed the literal
  // "event_pass", which is right only for as long as M stays the cheapest rung
  // — and `tsc` cannot see that assumption at all.
  it("is the cheapest rung in every supported currency", () => {
    const wrong = SUPPORTED_CURRENCIES.filter((c) => {
      const cheapest = Math.min(...PASS_KEYS.map((k) => passPrice(c, k)));
      return lowestPassRung(c).amountMinor !== cheapest;
    });
    expect(wrong.join(", ")).toBe("");
  });

  it("quotes M's real price point today, and names M as the rung it quoted", () => {
    expect(lowestPassRung("usd")).toEqual({ key: "event_pass", amountMinor: 2900 });
    expect(lowestPassRung("gbp")).toEqual({ key: "event_pass", amountMinor: 2500 });
  });

  it("never quotes the more expensive rung", () => {
    const over = SUPPORTED_CURRENCIES.filter(
      (c) => lowestPassRung(c).amountMinor > passPrice(c, "event_pass_l"),
    );
    expect(over.join(", ")).toBe("");
  });
});

describe("passActiveLabel", () => {
  // The held signal on the dashboard card, the competition header and
  // competition settings said a flat "Event Pass active" — the FAMILY name,
  // with nothing beside it naming the rung. An org that paid $59 for L reads
  // its competition as holding the $29 product.
  it("names the rung that is actually held", () => {
    expect(passActiveLabel(uiEn, "event_pass")).toBe("Event Pass M active");
    expect(passActiveLabel(uiEn, "event_pass_l")).toBe("Event Pass L active");
  });

  it("leaves no un-substituted placeholder in the rendered label", () => {
    // `t()` returns the literal `{rung}` when the caller forgets the var, and
    // three call sites would each have to remember. This helper is the reason
    // none of them can.
    for (const key of PASS_KEYS) expect(passActiveLabel(uiEn, key)).not.toContain("{");
  });

  it("labels each rung differently", () => {
    expect(passActiveLabel(uiEn, "event_pass")).not.toBe(passActiveLabel(uiEn, "event_pass_l"));
  });
});

describe("passActiveLabels", () => {
  // A server page holds the dict; only the client provider knows which rung is
  // held. So the page hands over BOTH finished strings and the island picks.
  it("carries a finished label for every rung the product sells", () => {
    const labels = passActiveLabels(uiEn);
    expect(PASS_KEYS.filter((k) => !labels[k]).join(", ")).toBe("");
    expect(new Set(Object.values(labels)).size).toBe(PASS_KEYS.length);
  });

  it("agrees with passActiveLabel rung for rung", () => {
    const labels = passActiveLabels(uiEn);
    for (const key of PASS_KEYS) expect(labels[key]).toBe(passActiveLabel(uiEn, key));
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
    //
    // 409 is deliberately NOT in this list any more (v17 gap #326): see below.
    for (const status of [400, 401, 402, 404, 429]) {
      expect(passCheckoutErrorKey(status)).toBe("upgrade.buyError.stale");
    }
  });

  it("does NOT tell an already-charged buyer to reload and try again (409)", () => {
    // The mint guard refused a payment that was taken, so the route freezes the
    // sale until staff resolve it. The 4xx bucket's whole premise — "the page is
    // out of date, reload" — is a confident lie to this reader: reloading
    // changes nothing and their money has already gone. Split out with its own
    // sentence for that reason, not for tidiness.
    expect(passCheckoutErrorKey(409)).toBe("upgrade.buyError.underReview");
    expect(passCheckoutErrorKey(409)).not.toBe(passCheckoutErrorKey(400));
  });

  it("says nothing it does not know for a 5xx, a rejected fetch or a missing secret", () => {
    for (const status of [500, 502, 504, null]) {
      expect(passCheckoutErrorKey(status)).toBe("upgrade.buyError.generic");
    }
  });
});

describe("PASS_LOCK_REASON_KEY / passEndedReasons", () => {
  const dict = uiEn;

  // W8 task 3 review, I-1. Every other assertion about these two sentences was
  // built FROM `passEndedReasons()` or FROM the Record — so swapping the
  // Record's two arms left the whole suite green, and the card would have told
  // an organiser whose competition merely ran past its end date that it was
  // "finished or archived", and told one whose competition had finished to go
  // and update the end date. The mapping is the thing most worth pinning and
  // was the one thing nothing pinned.
  //
  // Broken here by asserting against MEANING rather than against the mapping:
  // each reason's sentence has to talk about the situation that reason names.
  // A test that re-typed today's English would drift the first time the copy is
  // reworded; these two probes are about subject matter, not wording.
  it("points each reason at a sentence about that reason", () => {
    const terminal = passEndedReasons(dict).terminal;
    const pastEnds = passEndedReasons(dict).past_ends_on;

    // A finished/archived competition. Its next step is next season, NOT a date
    // edit — so the terminal sentence must not send anyone to the end date.
    expect(terminal).toMatch(/finished|archived/i);
    expect(terminal).not.toMatch(/end date/i);

    // A competition that merely ran past `ends_on` is often still being played,
    // and the date IS the fix. It must say so, and must not declare the
    // competition over.
    expect(pastEnds).toMatch(/end date/i);
    expect(pastEnds).not.toMatch(/finished|archived/i);
  });

  it("pins the two dictionary keys themselves", () => {
    // The literal keys, so a swap inside the Record is a diff in this file
    // rather than a silent re-pointing. Cheap, and it fails loudly in exactly
    // the case the review found.
    expect(PASS_LOCK_REASON_KEY).toEqual({
      terminal: "pass.entry.ended.reasonTerminal",
      past_ends_on: "pass.entry.ended.reasonPastEnds",
    });
  });

  it("covers every reason the resolver can return, with distinct real copy", () => {
    const reasons = passEndedReasons(dict);
    expect(Object.keys(reasons).sort()).toEqual([...PASS_LOCK_REASONS].sort());
    const sentences = Object.values(reasons);
    // Non-empty and non-identical: a missing dictionary key resolves to the key
    // name or to "", and two reasons sharing one sentence is the collapse the
    // separate arms exist to prevent.
    for (const s of sentences) {
      expect(s.length).toBeGreaterThan(20);
      expect(s).not.toMatch(/^pass\./);
    }
    expect(new Set(sentences).size).toBe(sentences.length);
  });
});
