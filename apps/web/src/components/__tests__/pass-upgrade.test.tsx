// The Event Pass M/L picker (v17 #294, spec A7) — the wave's one buyer-facing
// money surface.
//
// The failure this file exists to catch, in one sentence: **the buyer picks L
// and the POST body says M.** Nothing else in the stack can see that. The route
// happily sells whatever rung it is handed, `recordPassPurchase` records it,
// Stripe charges for it, and every assertion downstream agrees with itself —
// the only witness that the buyer asked for something else is the click.
//
// ── How this is tested without a DOM ────────────────────────────────────────
// vitest runs `environment: "node"` here and the workspace has no jsdom, so a
// `useState` component cannot be clicked (see competition-pass-entry.test.tsx
// and pass-checkout-parity.test.tsx for the same constraint). Two seams make
// that survivable:
//
//   `PassRungLadder`  hookless, so it can be CALLED and its returned element
//                     tree walked — including invoking the very handlers a
//                     browser would. This is where "which rung the button
//                     means" lives, so this is where the click can be faked.
//   `beginPassCheckout`  the one place a rung becomes money, lifted out of the
//                     component with an injectable fetch.
//
// What remains unproven here is the two-line stateful shell between them
// (`useState` + `start(passKey)`), which is verified in the browser instead.
import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PassRungLadder,
  beginPassCheckout,
  type PassCheckoutDeps,
} from "@/components/pass-upgrade";
import type { PassRungOption } from "@/lib/pass-ladder";
import type { Dict } from "@/lib/i18n-constants";
// The REAL dictionary, not a stub: `t()` returns the KEY on a miss, so this
// also fails if a key the picker needs was never added to en/ui.json.
import ui from "@/dictionaries/en/ui.json";

const dict = ui as Dict;

const OPTIONS: PassRungOption[] = [
  { key: "event_pass", amountMinor: 2900, entrants: 128, divisions: 10, credits: 25 },
  { key: "event_pass_l", amountMinor: 5900, entrants: null, divisions: 20, credits: 25 },
];

/** Every element in a returned tree, so handlers can be found and invoked. */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  return walk((node.props as { children?: ReactNode }).children, out);
}

type Props = Record<string, unknown>;
const propsOf = (el: ReactElement): Props => el.props as Props;

function ladder(overrides: Partial<Parameters<typeof PassRungLadder>[0]> = {}) {
  const props = {
    options: OPTIONS,
    currency: "usd" as const,
    dict,
    selected: "event_pass" as const,
    onSelect: () => {},
    onBuy: () => {},
    canBuy: true,
    loading: false,
    failure: null,
    ...overrides,
  };
  return { tree: walk(PassRungLadder(props)), html: renderToStaticMarkup(PassRungLadder(props)) };
}

/** Rendered copy with the markup taken out, lowercased — for assertions about
 *  what the buyer READS, which must not trip over Tailwind's class names. */
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();

const buyButton = (tree: ReactElement[]) =>
  tree.find((el) => "data-pass-buy" in propsOf(el));
const radios = (tree: ReactElement[]) => tree.filter((el) => el.type === "input");

describe("beginPassCheckout", () => {
  function deps() {
    return {
      fetchSecret: vi.fn<PassCheckoutDeps["fetchSecret"]>(async () => ({
        ok: true as const,
        clientSecret: "cs_test_x",
      })),
      trackEvent: vi.fn<PassCheckoutDeps["trackEvent"]>(),
    } satisfies PassCheckoutDeps;
  }

  it("buys the rung it is given, not a default", async () => {
    const d = deps();
    await beginPassCheckout("comp-1", "event_pass_l", d);
    expect(d.fetchSecret).toHaveBeenCalledTimes(1);
    // Asserted as a scalar first: `toHaveBeenCalledWith(…)` on the whole arg
    // list elides the rung in the reporter's message, which is the one value
    // this test exists to protect.
    expect(d.fetchSecret.mock.calls[0]![1]).toBe("event_pass_l");
    expect(d.fetchSecret).toHaveBeenCalledWith("comp-1", "event_pass_l");
  });

  it("reports the rung actually bought to analytics", async () => {
    // Pre-#294 this was the literal "event_pass". Left alone, every L sale
    // would land in the funnel as an M sale and the rung would look dead.
    const d = deps();
    await beginPassCheckout("comp-1", "event_pass_l", d);
    expect((d.trackEvent.mock.calls[0]![1] as { plan_key: string }).plan_key).toBe("event_pass_l");
  });

  it("hands the caller the checkout result untouched", async () => {
    const d = deps();
    await expect(beginPassCheckout("comp-1", "event_pass", d)).resolves.toEqual({
      ok: true,
      clientSecret: "cs_test_x",
    });
  });
});

describe("PassRungLadder — the rung the button means", () => {
  it("BUYS THE SELECTED RUNG", () => {
    // The regression test for this whole surface. A picker that shows L as
    // chosen and posts M is a silent mis-sale: right price on screen, wrong
    // product bought, no error anywhere.
    for (const selected of ["event_pass", "event_pass_l"] as const) {
      const onBuy = vi.fn();
      const { tree } = ladder({ selected, onBuy });
      (propsOf(buyButton(tree)!).onClick as () => void)();
      expect(onBuy).toHaveBeenCalledTimes(1);
      expect(onBuy.mock.calls[0]![0]).toBe(selected);
    }
  });

  it("checks exactly the selected rung's radio", () => {
    const { tree } = ladder({ selected: "event_pass_l" });
    const state = radios(tree).map((r) => `${propsOf(r).value}:${propsOf(r).checked}`);
    expect(state.join(" ")).toBe("event_pass:false event_pass_l:true");
  });

  it("pre-selects nothing of its own — the caller's first option is the default", () => {
    // M being the default is what lets the money-path e2e suite keep clicking
    // [data-pass-buy] straight through to Stripe without knowing this exists.
    const { tree } = ladder();
    const checked = radios(tree).filter((r) => propsOf(r).checked === true);
    expect(checked.map((r) => propsOf(r).value).join(", ")).toBe("event_pass");
  });

  it("asks for a new selection when a rung is chosen", () => {
    const onSelect = vi.fn();
    const { tree } = ladder({ onSelect });
    const l = radios(tree).find((r) => propsOf(r).value === "event_pass_l")!;
    (propsOf(l).onChange as () => void)();
    expect(onSelect.mock.calls[0]![0]).toBe("event_pass_l");
  });

  it("names the selected rung on the button", () => {
    expect(ladder({ selected: "event_pass_l" }).html).toContain("Buy the pass — L");
    expect(ladder({ selected: "event_pass" }).html).toContain("Buy the pass — M");
  });
});

describe("PassRungLadder — what the buyer is shown", () => {
  it("prices BOTH rungs, so neither has to be discovered by clicking", () => {
    const { html } = ladder();
    expect(html).toContain("$29");
    expect(html).toContain("$59");
  });

  it("leads each rung with the entrant and division difference", () => {
    const { html } = ladder();
    expect(html).toContain("Up to 10 divisions");
    expect(html).toContain("128 entrants each");
    expect(html).toContain("Up to 20 divisions");
    expect(html).toContain("Unlimited entrants");
  });

  it("carries no best-value marker", () => {
    // #294, owner's decision: unlike the credit-pack ladder, this one ships
    // without one. The two rungs are different sizes, not better and worse.
    const words = text(ladder({ selected: "event_pass_l" }).html);
    expect(words).not.toContain("best value");
    expect(words).not.toContain("recommended");
    expect(words).not.toContain("popular");
  });

  it("makes no multiplier claim about L", () => {
    // L's per-currency ratios are not uniform (2.03x usd, 1.96x gbp, 2.25x
    // inr), so "double the size for double the price" is false in some
    // currency. Copy may never say it.
    // Asserted on the rendered TEXT, not the markup: Tailwind ships `text-2xl`
    // and `py-2.5` in every class list, so a naive substring search over HTML
    // reds on the stylesheet rather than on the copy.
    const words = text(ladder({ selected: "event_pass_l" }).html);
    for (const claim of ["double", "twice", "2×", "2x", "half"]) {
      expect(words).not.toContain(claim);
    }
  });

  it("shows a non-owner both prices and no way to spend", () => {
    // The page's own rule: a non-owner's job here is to take a number to
    // whoever can spend it — with two rungs that means BOTH numbers.
    const { tree, html } = ladder({ canBuy: false });
    expect(buyButton(tree)).toBeUndefined();
    expect(html).toContain("$29");
    expect(html).toContain("$59");
    expect(html).toContain("disabled");
  });

  it("dresses nothing as chosen for a reader who cannot choose", () => {
    // The radio stays checked — a group needs one — but a lime "you picked
    // this" stamp inside a control they cannot operate claims a decision the
    // reader never made. For them the ladder is a price list.
    const { tree, html } = ladder({ canBuy: false });
    expect(html).not.toContain("data-pass-rung-active");
    expect(radios(tree).filter((r) => propsOf(r).checked === true)).toHaveLength(1);
    // …and the owner still gets the marker, so this is not just "never render".
    expect(ladder({ canBuy: true }).html).toContain("data-pass-rung-active");
  });

  it("says checkout is being prepared while it is", () => {
    const { tree, html } = ladder({ loading: true });
    expect(propsOf(buyButton(tree)!).disabled).toBe(true);
    expect(html).toContain("Preparing checkout…");
  });
});

describe("PassRungLadder — failed checkouts", () => {
  const rendered = (status: number | null) => ladder({ failure: { status } }).html;

  it("tells an unsynced rung's buyer to try the other size", () => {
    const html = rendered(503);
    expect(html).toContain("This pass size isn’t on sale right now.");
    expect(html).toContain('role="alert"');
  });

  it("treats every other refusal as a stale page", () => {
    expect(rendered(400)).toContain("the page may be out of date");
  });

  it("says nothing it does not know about a 5xx or a dead network", () => {
    expect(rendered(500)).toContain("Checkout is unavailable right now.");
    expect(rendered(null)).toContain("Checkout is unavailable right now.");
  });

  it("never prints the server's own words", () => {
    // Every message the route can emit is hardcoded English inside a
    // four-locale UI, and lib/http.ts returns a raw `err.message` on an
    // unexpected 500 — a Stripe or Postgres exception string one throw from
    // being rendered to a buyer as purchase advice.
    for (const status of [400, 404, 500, 503, null]) {
      const html = rendered(status);
      expect(html).not.toContain("Billing is not yet configured");
      expect(html).not.toContain("Invalid input");
      expect(html).not.toContain("competition not found");
    }
  });

  it("leaves the buy button live so the buyer can retry", () => {
    const { tree } = ladder({ failure: { status: 503 } });
    expect(propsOf(buyButton(tree)!).disabled).toBe(false);
  });

  it("shows nothing at all until something has failed", () => {
    expect(ladder().html).not.toContain('role="alert"');
  });
});
