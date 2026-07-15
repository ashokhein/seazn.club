// Every email builder now composes from the HTML files in email-templates/html.
// These tests fail against the old string-literal card() templates: they assert
// the courtside shell (slab masthead, preheader, court line), escaping of
// user-supplied content, and that no {{TOKEN}} leaks into a sent email.
import { describe, expect, it } from "vitest";
import {
  accountDeletionTemplate,
  disputeAlertTemplate,
  disputeLostTemplate,
  emailChangeConfirmTemplate,
  emailChangeNoticeTemplate,
  inviteTemplate,
  magicLinkTemplate,
  passwordResetTemplate,
  paymentReminderTemplate,
  refundIssuedTemplate,
  registrationPromotedTemplate,
  registrationTemplate,
  verificationTemplate,
} from "../email-templates";
import { standingsTable } from "../email-templates/compose";
// Localized builders take the emails dict; the en namespace is the source text.
import emailsEn from "@/dictionaries/en/emails.json";

const LINK = "https://seazn.club/x?token=abc";

const registrationArgs = {
  orgName: "Riverside Racquets",
  competitionName: "Spring Open 2026",
  displayName: "Alex",
  status: "pending",
  feeCents: 2500,
  currency: "gbp",
  paymentInstructions: "Bank transfer\nRef: SPRING",
  statusUrl: LINK,
};

const allBuilders: [string, { subject: string; html: string; text: string }][] = [
  ["verification", verificationTemplate(LINK, emailsEn)],
  ["password-reset", passwordResetTemplate(LINK, emailsEn)],
  ["magic-link", magicLinkTemplate(LINK, emailsEn)],
  ["email-change-confirm", emailChangeConfirmTemplate(LINK)],
  ["email-change-notice", emailChangeNoticeTemplate("new@example.com")],
  ["account-deletion", accountDeletionTemplate()],
  ["invite", inviteTemplate("Riverside Racquets", LINK)],
  ["registration", registrationTemplate(registrationArgs)],
  ["payment-reminder", paymentReminderTemplate(registrationArgs)],
  [
    "registration-promoted",
    registrationPromotedTemplate({
      ...registrationArgs,
      payUrl: LINK,
      payDeadline: "2026-08-01T12:00:00Z",
      refCode: "SZ-ABCD-EFGH",
      refStatusUrl: "https://seazn.club/r/SZ-ABCD-EFGH",
    }),
  ],
  [
    "refund-issued",
    refundIssuedTemplate({
      orgName: "Riverside Racquets",
      competitionName: "Spring Open 2026",
      displayName: "Alex",
      amountCents: 2500,
      currency: "gbp",
      refCode: "SZ-ABCD-EFGH",
    }),
  ],
  [
    "dispute-alert",
    disputeAlertTemplate({
      orgName: "Riverside Racquets",
      competitionName: "Spring Open 2026",
      displayName: "Alex",
      amountCents: 2500,
      currency: "gbp",
      refCode: "SZ-ABCD-EFGH",
    }),
  ],
  [
    "dispute-lost",
    disputeLostTemplate({
      orgName: "Riverside Racquets",
      competitionName: "Spring Open 2026",
      displayName: "Alex",
      amountCents: 2500,
      currency: "gbp",
      refCode: "SZ-ABCD-EFGH",
      recoveredCents: 2375,
      consoleUrl: LINK,
    }),
  ],
];

describe("email builders compose from the html templates", () => {
  for (const [name, out] of allBuilders) {
    it(`${name}: courtside shell, no unresolved tokens, non-empty text`, () => {
      // Stadium-night slab + pitch line + ball come from base.html only.
      expect(out.html).toContain('bgcolor="#150b36"');
      expect(out.html).toContain('bgcolor="#a3e635"');
      expect(out.html).toContain("&#9679;");
      expect(out.html).toContain("Barlow Condensed");
      // Preheader div present and filled.
      expect(out.html).toContain("mso-hide:all");
      // No template token survives substitution.
      expect(out.html).not.toMatch(/\{\{[A-Z_]+\}\}/);
      // Plain-text part still populated.
      expect(out.text.length).toBeGreaterThan(10);
      expect(out.subject.length).toBeGreaterThan(5);
    });
  }

  it("card registration carries a Pay now button and the deadline", () => {
    const out = registrationTemplate({
      ...registrationArgs,
      paymentInstructions: null,
      payUrl: "https://checkout.stripe.test/cs_1",
      payDeadline: "2026-08-01T12:00:00Z",
    });
    expect(out.html).toContain("https://checkout.stripe.test/cs_1");
    expect(out.html).toContain("Pay now");
    expect(out.text).toContain("https://checkout.stripe.test/cs_1");
  });

  it("card payment reminder links the fresh checkout, offline keeps instructions", () => {
    const card = paymentReminderTemplate({
      ...registrationArgs,
      paymentInstructions: null,
      checkoutUrl: "https://checkout.stripe.test/cs_2",
      payDeadline: "2026-08-01T12:00:00Z",
    });
    expect(card.html).toContain("https://checkout.stripe.test/cs_2");
    const offline = paymentReminderTemplate(registrationArgs);
    expect(offline.html).toContain("Bank transfer");
  });

  it("dispute-lost email states the loss, the balance debit and who pays the fee", () => {
    const out = disputeLostTemplate({
      orgName: "O", competitionName: "C", displayName: "D",
      amountCents: 2000, currency: "gbp", refCode: "SZ-XXXX-YYYY",
      recoveredCents: 1900, consoleUrl: LINK,
    });
    expect(out.subject.toLowerCase()).toContain("dispute lost");
    expect(out.text).toContain("SZ-XXXX-YYYY");
    expect(out.text).toContain("£20.00"); // disputed amount
    expect(out.text).toContain("£19.00"); // recovered from the club's balance
    expect(out.text.toLowerCase()).toContain("stripe balance");
    expect(out.text.toLowerCase()).toContain("dispute fee");
    expect(out.html).toContain(`href="${LINK}"`);
    // Recovery failed → no false claim that money moved.
    const failed = disputeLostTemplate({
      orgName: "O", competitionName: "C", displayName: "D",
      amountCents: 2000, currency: "gbp", refCode: null,
      recoveredCents: 0, consoleUrl: LINK,
    });
    expect(failed.text.toLowerCase()).not.toContain("recovered from your stripe balance");
  });

  it("refund email states the amount; dispute alert warns the organiser", () => {
    const refund = refundIssuedTemplate({
      orgName: "O", competitionName: "C", displayName: "D",
      amountCents: 1234, currency: "gbp", refCode: null,
    });
    expect(refund.text).toContain("12.34");
    const dispute = disputeAlertTemplate({
      orgName: "O", competitionName: "C", displayName: "D",
      amountCents: 1234, currency: "gbp", refCode: "SZ-XXXX-YYYY",
    });
    expect(dispute.subject.toLowerCase()).toContain("dispute");
    expect(dispute.text).toContain("SZ-XXXX-YYYY");
  });

  it("CTA builders carry the link in a button href", () => {
    for (const t of [
      verificationTemplate(LINK, emailsEn),
      passwordResetTemplate(LINK, emailsEn),
      magicLinkTemplate(LINK, emailsEn),
      emailChangeConfirmTemplate(LINK),
      inviteTemplate("Org", LINK),
      registrationTemplate(registrationArgs),
    ]) {
      expect(t.html).toContain(`href="${LINK}"`);
    }
  });

  it("localized CTA builders read the provided dict (not hardcoded English)", () => {
    const fr = { ...emailsEn, "magicLink.subject": "SUBJ_FR", "magicLink.button": "BTN_FR" };
    const out = magicLinkTemplate(LINK, fr);
    expect(out.subject).toBe("SUBJ_FR");
    expect(out.html).toContain("BTN_FR");
  });

  it("registration escapes user-supplied names in the html", () => {
    const out = registrationTemplate({
      ...registrationArgs,
      competitionName: 'Spring <script>alert("x")</script>',
      displayName: "A & B",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain("A &amp; B");
  });

  it("registration renders fee panel with instructions preserved", () => {
    const out = registrationTemplate(registrationArgs);
    expect(out.html).toContain("Entry fee: £25.00");
    expect(out.html).toContain(">Bank transfer\nRef: SPRING</p>");
  });

  it("registration carries the reference number + status link in html AND text (v3/05 §3)", () => {
    const out = registrationTemplate({
      ...registrationArgs,
      refCode: "SZ-ABCD-EFG2",
      refStatusUrl: "https://seazn.club/r/SZ-ABCD-EFG2",
    });
    expect(out.html).toContain("SZ-ABCD-EFG2");
    expect(out.html).toContain("https://seazn.club/r/SZ-ABCD-EFG2");
    expect(out.text).toContain("Your reference: SZ-ABCD-EFG2");
    expect(out.text).toContain("https://seazn.club/r/SZ-ABCD-EFG2");
    // Rows without a ref (pre-v2) keep the old shape — no dangling label.
    expect(registrationTemplate(registrationArgs).text).not.toContain("Your reference");
  });

  it("registration waitlist variant drops the fee panel", () => {
    const out = registrationTemplate({ ...registrationArgs, status: "waitlisted" });
    expect(out.html).toContain("on the waitlist");
    expect(out.html).not.toContain("Entry fee");
  });

  it("payment reminder without instructions points at the organiser", () => {
    const out = paymentReminderTemplate({ ...registrationArgs, paymentInstructions: null });
    expect(out.html).toContain("Please contact Riverside Racquets to arrange payment.");
  });

  it("standings table renders leader accent + zebra rows, escaped names", () => {
    const html = standingsTable({
      title: "Division 1",
      meta: "After week 6",
      nameHeader: "Team",
      rows: [
        { rank: 1, name: "A & B", played: 6, won: 6, lost: 0, points: 18, leader: true },
        { rank: 2, name: "C", played: 6, won: 4, lost: 2, points: 12 },
        { rank: 3, name: "D", played: 6, won: 3, lost: 3, points: 9 },
      ],
    });
    expect(html).toContain("border-left:3px solid #7c3aed"); // leader accent bar
    expect(html).toContain("A &amp; B");
    // Zebra alternation over row indices (rows 2 and 3 get opposite fills).
    expect(html).toContain('bgcolor="#faf9fc"');
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
});
