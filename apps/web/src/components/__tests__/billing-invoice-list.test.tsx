import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InvoiceList } from "../billing-invoice-list";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { InvoiceRow } from "@/lib/billing-manage";

const dict = uiEn as unknown as Dict;

const row = (over: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: "in_1",
  number: "A-1",
  createdIso: "2026-02-01T00:00:00.000Z",
  totalMinor: 1550,
  currency: "gbp",
  status: "paid",
  hostedUrl: "https://s/1",
  pdfUrl: "https://s/1.pdf",
  isOpen: false,
  ...over,
});

const render = (invoices: InvoiceRow[], note?: string) =>
  renderToStaticMarkup(
    createElement(InvoiceList, {
      invoices,
      heading: "Your past invoices",
      note,
      dict,
      locale: "en",
    }),
  );

describe("InvoiceList", () => {
  it("renders a row with heading, amount, status and PDF link", () => {
    const html = render([row()]);
    expect(html).toContain("Your past invoices");
    expect(html).toContain("£15.50");
    expect(html).toContain("paid");
    expect(html).toContain("PDF");
    expect(html).toContain("https://s/1.pdf");
  });

  it("shows the optional note under the heading", () => {
    expect(render([row()], "From when you paid.")).toContain("From when you paid.");
  });

  it("renders nothing when the list is empty", () => {
    expect(render([])).toBe("");
  });

  it("shows the Pay-now link only for an open invoice", () => {
    // The pay-now link is the only amber-700 element.
    expect(render([row({ isOpen: true })])).toContain("text-amber-700");
    expect(render([row({ isOpen: false })])).not.toContain("text-amber-700");
  });
});
