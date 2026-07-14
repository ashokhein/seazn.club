// {{reference}} substitution + Markdown→text stripping for organiser payment
// instructions (fails without lib/payment-instructions).
import { describe, expect, it } from "vitest";
import {
  fillPaymentInstructions,
  paymentInstructionsText,
} from "../payment-instructions";
import { registrationTemplate } from "../email-templates/registration";

describe("payment instructions", () => {
  it("fills {{reference}} with the ref code, everywhere it appears", () => {
    const out = fillPaymentInstructions(
      "Quote {{reference}} on the transfer. Ref: {{reference}}",
      "SZ-4F7K-2Q9D",
    );
    expect(out).toBe("Quote SZ-4F7K-2Q9D on the transfer. Ref: SZ-4F7K-2Q9D");
  });

  it("degrades gracefully before a reference exists", () => {
    expect(fillPaymentInstructions("Quote {{reference}}.", null)).toBe(
      "Quote your registration reference.",
    );
  });

  it("strips markdown to readable text for email panels", () => {
    expect(
      paymentInstructionsText(
        "## How to pay\n**Bank:** Example Bank\nPay via [our page](https://x.test/pay)\n> cash on the day works too",
      ),
    ).toBe(
      "How to pay\nBank: Example Bank\nPay via our page: https://x.test/pay\ncash on the day works too",
    );
  });

  it("registration email carries the personalised, stripped instructions", () => {
    const { html, text } = registrationTemplate({
      orgName: "Riverside",
      competitionName: "Spring Open",
      displayName: "Alex",
      status: "pending",
      feeCents: 2500,
      currency: "gbp",
      paymentInstructions: "**Quote {{reference}}** on your transfer.",
      statusUrl: "https://x.test/status",
      refCode: "SZ-AAAA-BBBB",
    });
    expect(html).toContain("Quote SZ-AAAA-BBBB on your transfer.");
    expect(html).not.toContain("{{reference}}");
    expect(html).not.toContain("**");
    expect(text).toContain("Quote SZ-AAAA-BBBB on your transfer.");
  });
});
