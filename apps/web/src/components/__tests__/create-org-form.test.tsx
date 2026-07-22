import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
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
});

describe("CreateOrgForm (SSR baseline)", () => {
  it("renders the name-only form before any billing group loads", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={enDict} locale="en">
        <CreateOrgForm />
      </DictProvider>,
    );
    expect(html).toContain("Organization name");
    // The default action is the plain create button; the billing fieldset only
    // appears once at least one owned group has been fetched.
    expect(html).toContain("Create organization");
    expect(html).not.toContain("Add to an existing bill");
  });
});
