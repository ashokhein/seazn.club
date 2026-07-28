import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BillRow,
  CreateOrgForm,
  eligibility,
  submitLabel,
  type CreateOrgGroup,
} from "../create-org-form";
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
