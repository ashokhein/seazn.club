import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import {
  BillRow,
  CreateOrgForm,
  eligibility,
  fullBillOffers,
  submitLabel,
  type CreateOrgGroup,
} from "../create-org-form";
import { propsOf, renderIsland, textOf, walk } from "./_hook-harness";
import ConsoleLink from "@/components/ui/console-link";
import { DictProvider } from "@/components/i18n/dict-provider";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { MessageKey } from "@/lib/messages";

// next/navigation is used by the client container; stub for the SSR render.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// This component's billing data arrives in an effect and this repo's vitest
// environment is `node` with no jsdom (see lib/billing-group-view.ts) — so a
// render test would run no effect and assert against the name-only markup it
// returns before the fetch lands. The DECISIONS the picker makes are therefore
// tested directly against the real English catalog, which is what a screenshot
// or an e2e would ultimately read. `msg` here is the exact interpolation the
// component runs (lib/i18n-runtime `t`), so these strings are the shipped ones.
const enDict = uiEn as unknown as Dict;
const msg = (key: MessageKey, vars?: Record<string, string | number>) =>
  t(enDict, key, vars);

const proGroup: CreateOrgGroup = {
  id: "sub_pro",
  plan_key: "pro",
  status: "active",
  cancel_at_period_end: false,
  has_live_subscription: true,
  max_orgs: 5,
  orgs: [{ id: "o1", name: "Riverside" }],
};

// max_orgs 1 with one org on it → always Full, so it is offered but disabled.
const fullGroup: CreateOrgGroup = {
  id: "sub_full",
  plan_key: "pro",
  status: "active",
  cancel_at_period_end: false,
  has_live_subscription: true,
  max_orgs: 1,
  orgs: [{ id: "o2", name: "Northside" }],
};

describe("create-org-form billing decisions", () => {
  it("(a) offers an eligible group and marks a full one disabled with 'Full'", () => {
    expect(eligibility(proGroup, msg)).toEqual({ eligible: true });

    const full = eligibility(fullGroup, msg);
    expect(full.eligible).toBe(false);
    expect(full.reason).toBe("Full");
  });

  it("(v17 gap #293) a full pro/pro_plus group's reason carries an Add-ons link when the org has a slug", () => {
    const fullWithSlug = {
      ...fullGroup,
      orgs: [{ id: "o2", name: "Northside", slug: "northside" }],
    };
    const full = eligibility(fullWithSlug, msg, ["o2"]);
    expect(full.addOnsHref).toBe("/o/northside/settings/add-ons");
  });

  it("omits the Add-ons link when the group has no org to hang a slug off", () => {
    expect(eligibility(fullGroup, msg).addOnsHref).toBeUndefined();
  });

  it("an ELIGIBLE group never carries an addOnsHref (nothing to buy)", () => {
    expect(eligibility(proGroup, msg)).toEqual({ eligible: true });
  });

  // The link's job is to end a dead end. Each case below would REPLACE it with
  // a different dead end — a page that can only answer with a notice, or a
  // 404 — so each must keep the plain "Full" pill instead. The pill is
  // asserted alongside every one of them: an addOnsHref that is undefined
  // because the FULL branch was never reached would prove nothing.
  it("offers nothing on a Community bill — permanently full, and nothing to sell", () => {
    const community = {
      ...fullGroup,
      plan_key: "community",
      orgs: [{ id: "o2", name: "Northside", slug: "northside" }],
    };
    const seen = eligibility(community, msg, ["o2"]);
    expect(seen.reason).toBe("Full");
    expect(seen.addOnsHref).toBeUndefined();
  });

  it("offers nothing when the bill has no live subscription to ride", () => {
    const comped = {
      ...fullGroup,
      has_live_subscription: false,
      orgs: [{ id: "o2", name: "Northside", slug: "northside" }],
    };
    const seen = eligibility(comped, msg, ["o2"]);
    expect(seen.reason).toBe("Full");
    expect(seen.addOnsHref).toBeUndefined();
  });

  it("links the org the payer is a MEMBER of, not simply the first on the bill", () => {
    // A payer need not belong to what they pay for (the shape after a bill
    // transfer), and every /o page 404s a non-member — so the first org is the
    // wrong answer whenever it is not one of theirs.
    const mixed = {
      ...fullGroup,
      max_orgs: 2,
      orgs: [
        { id: "theirs", name: "Northside", slug: "northside" },
        { id: "mine", name: "Riverside", slug: "riverside" },
      ],
    };
    expect(eligibility(mixed, msg, ["mine"]).addOnsHref).toBe(
      "/o/riverside/settings/add-ons",
    );

    const stranger = eligibility(mixed, msg, ["unrelated-org"]);
    expect(stranger.reason).toBe("Full");
    expect(stranger.addOnsHref).toBeUndefined();
  });

  it("a full bill that is ALSO overdue offers the overdue reason and no purchase", () => {
    // Buying capacity on a bill whose card is declining is not the remedy, and
    // the charge would fail anyway.
    const overdue = {
      ...fullGroup,
      status: "past_due",
      orgs: [{ id: "o2", name: "Northside", slug: "northside" }],
    };
    const seen = eligibility(overdue, msg, ["o2"]);
    expect(seen.reason).toBe("Payment overdue");
    expect(seen.addOnsHref).toBeUndefined();
  });

  it("reads each ineligibility reason from the catalog", () => {
    expect(eligibility({ ...proGroup, status: "past_due" }, msg).reason).toBe(
      "Payment overdue",
    );
    expect(
      eligibility({ ...proGroup, cancel_at_period_end: true }, msg).reason,
    ).toBe("Scheduled to cancel");
    expect(eligibility({ ...proGroup, status: "unpaid" }, msg).reason).toBe(
      "Not active",
    );
  });

  it("(b) prices the submit button from the preview amount", () => {
    // $9.00 → formatMinor drops the decimals on whole amounts (the repo helper
    // billing-group-panel uses), so the honest rendered label is "$9 now".
    const label = submitLabel({
      choice: "add",
      preview: { amount_minor: 900, currency: "usd" },
      msg,
    });
    expect(label).toBe("Create & add — $9 now");

    // A fractional amount keeps its cents.
    expect(
      submitLabel({
        choice: "add",
        preview: { amount_minor: 1350, currency: "usd" },
        msg,
      }),
    ).toBe("Create & add — $13.50 now");
  });

  it("labels a free move without a price", () => {
    expect(submitLabel({ choice: "add", preview: null, msg })).toBe(
      "Create & add to this bill",
    );
  });

  it("(c) 'Bill this separately' keeps the plain create label", () => {
    expect(submitLabel({ choice: "separate", preview: null, msg })).toBe(
      "Create organization",
    );
  });

  it("(d) the terminal done-state action navigates with a fixed label", () => {
    // After a create where the attach failed the org already exists, so the
    // page swaps the create button for this navigate-only action. The label is
    // read straight from the catalog — no interpolation.
    expect(msg("orgNew.continueToBoard")).toBe("Continue to your board");
  });

  it("(e) no eligible bills disables 'add' and shows the muted hint", () => {
    // The component filters exactly this way; a lone Full group leaves nothing
    // to add to, so the 'Add to an existing bill' radio is disabled.
    const groups = [fullGroup];
    const eligibleGroups = groups.filter((g) => eligibility(g, msg).eligible);
    expect(eligibleGroups.length).toBe(0);
    expect(msg("orgNew.bill.noneEligible")).toBe(
      "No eligible bills — each needs an open slot on Pro or Pro Plus.",
    );
  });
});

// The decisions above are only half of it: `eligibility` could return a
// perfect addOnsHref that no markup ever reads, or markup could render the link
// for every row regardless. These render the row a customer actually sees.
describe("BillRow (v17 gap #293 — the rendered picker row)", () => {
  const renderRow = (g: CreateOrgGroup, memberOrgIds: string[]) =>
    renderToStaticMarkup(
      <ul>
        <BillRow
          g={g}
          msg={msg}
          selectedId=""
          memberOrgIds={memberOrgIds}
          onPick={() => {}}
        />
      </ul>,
    );

  const fullPro: CreateOrgGroup = {
    ...fullGroup,
    orgs: [{ id: "o2", name: "Northside", slug: "northside" }],
  };

  it("draws the Add-ons link, in English, next to the Full pill", () => {
    const html = renderRow(fullPro, ["o2"]);
    expect(html).toContain("Full");
    expect(html).toContain('href="/o/northside/settings/add-ons"');
    // The sentence, not the key — this is the copy that ships.
    expect(html).toContain("Buy another slot");
  });

  it("keeps the link OUTSIDE the row button, which is disabled and inert", () => {
    // An anchor inside a button is invalid HTML, and a disabled button
    // swallows pointer events for its entire subtree — a link nested there
    // renders perfectly and cannot be clicked.
    const html = renderRow(fullPro, ["o2"]);
    expect(html).toContain("disabled=");
    const buttonClose = html.indexOf("</button>");
    expect(buttonClose).toBeGreaterThan(-1);
    expect(html.indexOf("<a ")).toBeGreaterThan(buttonClose);
  });

  it("draws the Full pill but NO link when there is nothing to sell", () => {
    // Positive discriminator: the row still renders and still says Full, so
    // this is the link's absence and not an unrendered row.
    const html = renderRow({ ...fullPro, plan_key: "community" }, ["o2"]);
    expect(html).toContain("Full");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Buy another slot");
  });

  it("draws neither pill nor link on a bill with room", () => {
    const html = renderRow(proGroup, ["o1"]);
    expect(html).toContain("Riverside");
    expect(html).not.toContain("Full");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("disabled=");
  });

  it("names the FIRST org and counts the rest — never the whole join", () => {
    // The archetypal customer for this feature is a 5/5 Pro bill, and joining
    // every name ran ~119 characters / three wrapped lines at 375px once the
    // offer interpolates the label into a sentence.
    const fiveUp: CreateOrgGroup = {
      ...proGroup,
      max_orgs: 5,
      orgs: [
        { id: "o1", name: "Riverside Netball Club", slug: "riverside" },
        { id: "o2", name: "Northside Netball Club" },
        { id: "o3", name: "Eastside Netball Club" },
        { id: "o4", name: "Westside Netball Club" },
        { id: "o5", name: "Southside Netball Club" },
      ],
    };
    const html = renderRow(fiveUp, ["o1"]);
    expect(html).toContain("Riverside Netball Club +4 more");
    // The discriminator that makes the count real rather than a coincidence:
    // the four other names are NOT on screen.
    expect(html).not.toContain("Northside");
    expect(html).not.toContain("Southside");
  });

  it("uses the singular form for exactly one other bill member", () => {
    // en reads the same either way; fr does not ("autre" / "autres"), and the
    // key pair is what carries that. Picking `.other` for a count of 1 would
    // be invisible in English for ever.
    const twoUp: CreateOrgGroup = {
      ...proGroup,
      orgs: [
        { id: "o1", name: "Riverside", slug: "riverside" },
        { id: "o2", name: "Northside" },
      ],
    };
    expect(msg("orgNew.bill.andMore.one", { name: "Riverside", count: 1 })).toBe(
      "Riverside +1 more",
    );
    expect(renderRow(twoUp, ["o1"])).toContain("Riverside +1 more");
  });

  it("names a lone bill member with no suffix at all", () => {
    // The common case must not read "Riverside +0 more".
    const html = renderRow(proGroup, ["o1"]);
    expect(html).toContain("Riverside");
    expect(html).not.toContain("more");
  });

  it("describes the link by its bill's name — several full bills, several links", () => {
    // Without this, two full bills put two links reading "Buy another slot"
    // on one page with nothing to tell them apart.
    const html = renderRow(fullPro, ["o2"]);
    const [, id] = /id="(bill-name-[^"]+)"/.exec(html) ?? [];
    expect(id).toBe(`bill-name-${fullPro.id}`);
    expect(html).toContain(`aria-describedby="${id}"`);
  });
});

// Every bill full is the archetypal state for this feature — one Pro bill at
// 5/5 — and it is the one state where the picker CANNOT be opened: its toggle
// is disabled while nothing is eligible, so the rows (and their links) never
// render. The offer has to be made beside the "no eligible bills" note instead.
describe("fullBillOffers (v17 gap #293 — the picker cannot be opened)", () => {
  const fullPro: CreateOrgGroup = {
    ...fullGroup,
    orgs: [{ id: "o2", name: "Northside", slug: "northside" }],
  };

  it("offers every full bill that can be bought out of, when none is eligible", () => {
    expect(fullBillOffers([fullPro], msg, ["o2"])).toEqual([
      { group: fullPro, href: "/o/northside/settings/add-ons" },
    ]);
  });

  it("offers nothing while ANY bill is eligible — the rows are reachable then", () => {
    // Otherwise the same purchase is offered twice on one screen, and the two
    // read as two different things to buy.
    expect(fullBillOffers([proGroup, fullPro], msg, ["o1", "o2"])).toEqual([]);
  });

  it("skips the full bills with nothing to sell, and keeps the rest", () => {
    const community = { ...fullPro, id: "sub_comm", plan_key: "community" };
    expect(fullBillOffers([community, fullPro], msg, ["o2"])).toEqual([
      { group: fullPro, href: "/o/northside/settings/add-ons" },
    ]);
  });
});

// The join nothing else witnesses: page -> `memberOrgIds` -> row -> href.
// Replacing the prop with `[]` at either end leaves every test above green and
// the link rendered for nobody, so this drives the real island with its data
// arriving the way it does in a browser — through the effect.
describe("CreateOrgForm island (v17 gap #293 — the wiring, end to end)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** BillRow is hookless, so the harness can expand it — which is the only way
   *  the row's own link is visible from the form's tree. */
  const expandRows = (node: ReactNode): ReactElement[] => {
    const top = walk(node);
    const rows = top.filter((el) => el.type === BillRow);
    return [
      ...top,
      ...rows.flatMap((el) => walk(BillRow(propsOf(el) as Parameters<typeof BillRow>[0]))),
    ];
  };

  function mount(groups: CreateOrgGroup[], memberOrgIds: string[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          String(url).includes("/api/billing/groups")
            ? { ok: true, data: groups }
            : { ok: true, data: { preview: null } },
      })),
    );
    return renderIsland(CreateOrgForm, { memberOrgIds }, expandRows);
  }

  const linksIn = (tree: ReactElement[]) => tree.filter((el) => el.type === ConsoleLink);
  const buttonNamed = (tree: ReactElement[], label: string) =>
    tree.find((el) => el.type === "button" && textOf(el) === label);

  const fullPro: CreateOrgGroup = {
    ...fullGroup,
    orgs: [{ id: "o2", name: "Northside Netball", slug: "northside" }],
  };

  it("offers the purchase when the ONE bill is full and the picker is shut", async () => {
    const island = mount([fullPro], ["o2"]);
    await flush();

    // The discriminator: this is genuinely the unreachable state, not a row
    // that happens to be on screen.
    const toggle = buttonNamed(island.tree(), "Add to an existing bill");
    expect(propsOf(toggle!).disabled).toBe(true);
    expect(island.text()).toContain(
      "No eligible bills — each needs an open slot on Pro or Pro Plus.",
    );

    const links = linksIn(island.tree());
    expect(links.map((l) => propsOf(l).href)).toEqual(["/o/northside/settings/add-ons"]);
    expect(textOf(links[0])).toBe("Buy another slot for Northside Netball →");
  });

  // The clipping fix IS the CSS, and nothing else in this wave can see it. The
  // app sets `overflow-x: clip`, so a label that runs past the right edge is
  // CUT rather than scrolled: `scrollWidth === clientWidth` reads clean and the
  // standing 375px overflow check is STRUCTURALLY BLIND to it. Measured in a
  // prod build at 375px wide, this element went 1238px -> 334px. Both classes
  // were verified by swapping them out one at a time, so neither is decoration.
  it("keeps the interpolated name breakable — these two classes ARE the fix", async () => {
    const longName = "Wellingborough" + "andDistrictNetballAssociation".repeat(3);
    const island = mount(
      [{ ...fullGroup, orgs: [{ id: "o2", name: longName, slug: "northside" }] }],
      ["o2"],
    );
    await flush();

    const links = linksIn(island.tree());
    // Positive discriminator: the offer IS rendered and IS carrying the long
    // name, so the class assertions below cannot pass against an absent link.
    expect(textOf(links[0])).toContain(longName);

    const className = String(propsOf(links[0]).className);
    // `overflow-wrap: anywhere`, NOT `break-words` (`overflow-wrap: break-word`):
    // only `anywhere` shrinks the element's min-content width. Swapping to
    // `break-words` leaves the label 1238px wide and clipped.
    expect(className).toContain("[overflow-wrap:anywhere]");
    // `inline-block`, NOT `inline`: an inline box is not sized from its
    // min-content width at all, so the wrap rule above would have no box to
    // act on and the label clips again.
    expect(className).toMatch(/\binline-block\b/);
  });

  it("makes no offer for a bill the payer is not a member of", async () => {
    // Same shut picker, same full bill — only the membership differs, so an
    // absence here cannot be an unrendered form.
    const island = mount([fullPro], ["someone-elses-org"]);
    await flush();
    expect(island.text()).toContain("No eligible bills");
    expect(linksIn(island.tree())).toEqual([]);
  });

  it("carries the prop into the row's link once the picker IS opened", async () => {
    const island = mount([proGroup, fullPro], ["o1", "o2"]);
    await flush();
    // Nothing yet: the default is "bill this separately", so no rows render.
    expect(linksIn(island.tree())).toEqual([]);

    (propsOf(buttonNamed(island.tree(), "Add to an existing bill")!).onClick as () => void)();
    await flush();

    const links = linksIn(island.tree());
    expect(links.map((l) => propsOf(l).href)).toEqual(["/o/northside/settings/add-ons"]);
    expect(textOf(links[0])).toBe("Buy another slot →");
  });

  // `fullBillOffers` returning two entries is pinned at the function level, but
  // the island renders them through a `.map` that nothing else drives. A `[0]`
  // where the map belongs would leave every function-level test green and sell
  // the second payer nothing.
  it("renders one named offer per full bill when SEVERAL are full", async () => {
    const fullPlus: CreateOrgGroup = {
      ...fullGroup,
      id: "sub_full_2",
      plan_key: "pro_plus",
      orgs: [{ id: "o3", name: "Eastside Hockey", slug: "eastside" }],
    };
    const island = mount([fullPro, fullPlus], ["o2", "o3"]);
    await flush();

    const links = linksIn(island.tree());
    expect(links.map((l) => propsOf(l).href)).toEqual([
      "/o/northside/settings/add-ons",
      "/o/eastside/settings/add-ons",
    ]);
    // Two links reading the same sentence would be two indistinguishable
    // things to buy — each has to name the bill it would raise.
    expect(links.map((l) => textOf(l))).toEqual([
      "Buy another slot for Northside Netball →",
      "Buy another slot for Eastside Hockey →",
    ]);
  });

  it("renders no row link when the form is handed an empty membership", async () => {
    const island = mount([proGroup, fullPro], []);
    await flush();
    (propsOf(buttonNamed(island.tree(), "Add to an existing bill")!).onClick as () => void)();
    await flush();
    // The rows ARE on screen — both bills are named — so this is the link's
    // absence, not the picker's.
    expect(island.tree().some((el) => textOf(el).includes("Northside Netball"))).toBe(true);
    expect(linksIn(island.tree())).toEqual([]);
  });
});

describe("CreateOrgForm (SSR baseline)", () => {
  it("renders the name-only form before any billing group loads", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={enDict} locale="en">
        <CreateOrgForm memberOrgIds={[]} />
      </DictProvider>,
    );
    expect(html).toContain("Organization name");
    // The default action is the plain create button; the billing fieldset only
    // appears once at least one owned group has been fetched.
    expect(html).toContain("Create organization");
    expect(html).not.toContain("Add to an existing bill");
  });
});
