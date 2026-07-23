import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ProrationSummary } from "../billing-manage";
import type { IntervalPreview } from "@/lib/billing-manage";

// This repo's vitest runs in `node` with no jsdom, so components are asserted
// against their SSR markup (see create-org-form.test.tsx). ProrationSummary is
// pure — it renders straight from its preview prop with no effect — so the
// markup is exactly what ships.

const base: IntervalPreview = {
  interval: "annual",
  trialing: false,
  dueTodayMinor: 0,
  creditMinor: 0,
  newPeriodMinor: 0,
  unusedCreditMinor: 0,
  subtotalMinor: 0,
  taxMinor: 0,
  currency: "gbp",
  newPeriodEnd: "2027-07-22T00:00:00.000Z",
  renewalAmountMinor: 12_500,
  prorationDate: 0,
};

const render = (preview: IntervalPreview, heading = "Switch to yearly billing") =>
  renderToStaticMarkup(
    createElement(ProrationSummary, {
      preview,
      heading,
      actions: createElement("button", null, "Confirm switch"),
      error: null,
    }),
  );

describe("ProrationSummary", () => {
  it("itemizes an upgrade with tax: new period, credit, subtotal, tax, total (the invoice shape)", () => {
    const html = render({
      ...base,
      dueTodayMinor: 10_222,
      newPeriodMinor: 15_000,
      unusedCreditMinor: 6_482,
      subtotalMinor: 8_518,
      taxMinor: 1_704,
    });
    expect(html).toContain("New billing period");
    expect(html).toContain("£150"); // whole pounds render without .00
    expect(html).toContain("Credit for unused time");
    expect(html).toContain("64.82"); // −£64.82 (unicode minus omitted from the match)
    expect(html).toContain("Subtotal");
    expect(html).toContain("£85.18");
    expect(html).toContain("Tax");
    expect(html).toContain("£17.04");
    expect(html).toContain("Charged today");
    expect(html).toContain("£102.22");
    expect(html).toContain("Then renews at");
    expect(html).toContain("£125/yr");
    expect(html).toContain("from 22 Jul 2027");
  });

  it("hides the Subtotal and Tax rows when the customer is not taxed", () => {
    const html = render({
      ...base,
      dueTodayMinor: 8_518,
      newPeriodMinor: 15_000,
      unusedCreditMinor: 6_482,
      subtotalMinor: 8_518,
      taxMinor: 0,
    });
    expect(html).toContain("Charged today");
    expect(html).toContain("£85.18");
    expect(html).not.toContain("Subtotal");
    expect(html).not.toContain(">Tax<");
  });

  it("flips to account credit on a downgrade — no charge today", () => {
    const html = render(
      {
        ...base,
        interval: "monthly",
        dueTodayMinor: 0,
        creditMinor: 8_818,
        newPeriodMinor: 1_250,
        unusedCreditMinor: 10_068,
        subtotalMinor: -8_818,
        taxMinor: 0,
        newPeriodEnd: "2026-08-22T00:00:00.000Z",
        renewalAmountMinor: 1_250,
      },
      "Switch to monthly billing",
    );
    expect(html).toContain("Credit to your balance");
    expect(html).toContain("£88.18");
    expect(html).toContain("this credit pays your future invoices");
    expect(html).not.toContain("Charged today");
    expect(html).toContain("£12.50/mo");
  });

  it("keeps the plain free-trial line while trialing — nothing to prorate", () => {
    const html = render({ ...base, trialing: true });
    expect(html).toContain("free trial");
    expect(html).toContain("£125/yr");
    expect(html).not.toContain("New billing period");
    expect(html).not.toContain("Charged today");
  });
});
