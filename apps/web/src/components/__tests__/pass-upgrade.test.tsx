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
// Those two seams leave one JOIN unwitnessed: the stateful shell that carries
// the selection from the ladder to `beginPassCheckout`. That join is exactly
// the mis-sale above — substituting a literal `"event_pass"` for `passKey`
// inside `PassUpgradeButton.start` used to pass every suite AND `tsc`. So the
// last describe in this file drives the SHELL too, with the ~30-line hook
// harness below. See its comment for why that is not as reckless as it reads.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// The useState dispatcher shim + tree walkers live in one place now (v17 gap
// #293 needed the same harness for the Add-ons control); see that file's
// comment for why this is not as reckless as it reads.
import { propsOf, renderIsland, walk } from "./_hook-harness";
import {
  PassRungLadder,
  PassUpgradeButton,
  beginPassCheckout,
  type PassCheckoutDeps,
} from "@/components/pass-upgrade";
// Mocked at the MODULE, not injected: the shell calls `beginPassCheckout` with
// its default deps, so this is the only place a spy can sit on the real
// production path from the click to the POST.
import { fetchPassCheckoutClientSecret } from "@/lib/billing-checkout-client";
import type { PassRungOption } from "@/lib/pass-ladder";
import type { Dict } from "@/lib/i18n-constants";
// The REAL dictionary, not a stub: `t()` returns the KEY on a miss, so this
// also fails if a key the picker needs was never added to en/ui.json.
import ui from "@/dictionaries/en/ui.json";

vi.mock("@/lib/billing-checkout-client", () => ({
  fetchPassCheckoutClientSecret: vi.fn(),
}));

const dict = ui as Dict;

const OPTIONS: PassRungOption[] = [
  { key: "event_pass", amountMinor: 2900, entrants: 128, divisions: 10, credits: 25 },
  { key: "event_pass_l", amountMinor: 5900, entrants: null, divisions: 20, credits: 25 },
];

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

// ── Driving the stateful shell without a DOM ────────────────────────────────
//
// `PassUpgradeButton` is a `useState` component, and calling it directly throws
// "Invalid hook call" — which is why the three legs above are tested through a
// hookless ladder and an injectable checkout, and why the join between them was
// left to a manual browser check. A manual check is not a regression test: the
// mis-sale can be reintroduced by one token and nothing in CI would say so.
//
// `renderIsland` (./_hook-harness) supplies React's hook dispatcher so that
// join can be driven here. See that file for how it works and how it fails
// loudly on a React upgrade.
/**
 * `walk` plus one deliberate step further: a `PassRungLadder` element is
 * EXPANDED into what it renders, because that is where the radios and the buy
 * button live and this harness has no renderer to do it.
 *
 * Only the ladder, and only because it is hookless. `PassCheckoutSheet` is left
 * opaque on purpose — expanding it would mount Stripe's provider and `Modal`,
 * neither of which this suite stands up.
 */
function expandTree(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) expandTree(child, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  if (node.type === PassRungLadder) {
    return expandTree(PassRungLadder(node.props as Parameters<typeof PassRungLadder>[0]), out);
  }
  return expandTree((node.props as { children?: ReactNode }).children, out);
}

describe("PassUpgradeButton — the buyer's selection reaches checkout", () => {
  const secret = vi.mocked(fetchPassCheckoutClientSecret);

  beforeEach(() => {
    secret.mockReset();
    secret.mockResolvedValue({ ok: true, clientSecret: "cs_test_x" });
  });

  function mount() {
    // `expandTree`, not the default walk: the radios and the buy button live
    // inside the (hookless) ladder, and the harness has no renderer to reach
    // them.
    return renderIsland(
      PassUpgradeButton,
      {
        competitionId: "comp-1",
        options: OPTIONS,
        currency: "usd" as const,
        dict,
        canBuy: true,
      },
      (node) => expandTree(node),
    );
  }

  const pick = (island: ReturnType<typeof mount>, key: string) => {
    const radio = radios(island.tree()).find((r) => propsOf(r).value === key);
    (propsOf(radio!).onChange as () => void)();
  };
  const press = async (island: ReturnType<typeof mount>) => {
    // `onBuy` returns the shell's async `start`, so awaiting the handler awaits
    // the checkout call itself — no microtask guessing.
    await (propsOf(buyButton(island.tree())!).onClick as () => unknown)();
  };

  it("CHARGES FOR THE RUNG THE BUYER PICKED", async () => {
    // The mis-sale, end to end through the real shell: choose L, press the one
    // button, and see which rung crossed into checkout. Every leg of this is
    // production code — the picker's onChange, `useState`, `start`'s parameter
    // forwarding, `beginPassCheckout` — with only the network mocked.
    const island = mount();
    pick(island, "event_pass_l");
    await press(island);

    expect(secret).toHaveBeenCalledTimes(1);
    // Scalar first: `toHaveBeenCalledWith` elides the rung in the JSON
    // reporter's message, and the rung is the entire point of this test.
    expect(secret.mock.calls[0]![1]).toBe("event_pass_l");
    expect(secret).toHaveBeenCalledWith("comp-1", "event_pass_l");
  });

  it("still sells M when M is what is left selected", async () => {
    // Keeps the test above honest: a shell hardcoded to L would pass it. This
    // is also the exact path apps/web/e2e/event-pass.spec.ts drives — it never
    // touches the picker, so M must survive an untouched ladder.
    const island = mount();
    await press(island);

    expect(secret.mock.calls[0]![1]).toBe("event_pass");
    expect(secret).toHaveBeenCalledWith("comp-1", "event_pass");
  });

  it("lets the buyer change their mind before paying", async () => {
    const island = mount();
    pick(island, "event_pass_l");
    pick(island, "event_pass");
    await press(island);

    expect(secret.mock.calls[0]![1]).toBe("event_pass");
  });

  it("opens Stripe on the first press, with nothing in between", async () => {
    // e2e/event-pass.spec.ts:325,922 click [data-pass-buy] and wait DIRECTLY
    // for the Stripe iframe. This pins that contract: one press, and the very
    // next render is the checkout sheet carrying the secret.
    secret.mockResolvedValue({ ok: true, clientSecret: "cs_test_l" });
    const island = mount();
    pick(island, "event_pass_l");
    await press(island);

    // Asserted on the ELEMENT, not on rendered markup: the sheet mounts
    // Stripe's real provider, which this suite deliberately does not stand up.
    const sheet = island.tree().find((el) => "clientSecret" in propsOf(el));
    expect(propsOf(sheet!).clientSecret).toBe("cs_test_l");
    // …and the ladder is gone, so no second step was inserted before payment.
    expect(buyButton(island.tree())).toBeUndefined();
  });

  it("does not take the whole island down when handed no rungs", () => {
    // Unreachable today — `passLadderOptions()` always returns both — but this
    // is a "use client" component, and a throw during its render does not
    // degrade to a blank stub: it takes the island's interactivity with it,
    // buy button included. A non-null assertion on a PROP is a crash waiting
    // for a caller.
    expect(() =>
      renderIsland(PassUpgradeButton, {
        competitionId: "comp-1",
        options: [],
        currency: "usd" as const,
        dict,
        canBuy: true,
      }).tree(),
    ).not.toThrow();
  });

  it("surfaces the refusal's status, so the buyer gets localised copy", async () => {
    secret.mockResolvedValue({ ok: false, error: "Billing is not yet configured", status: 503 });
    const island = mount();
    pick(island, "event_pass_l");
    await press(island);

    const alert = island.tree().find((el) => "data-pass-buy-error" in propsOf(el));
    expect(alert).toBeDefined();
    // The ladder is still there — a failed attempt must not swallow the picker.
    expect(buyButton(island.tree())).toBeDefined();
  });
});
