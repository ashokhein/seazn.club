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
  officialAssignedTemplate,
  officialAssignmentChangedTemplate,
  officialInviteTemplate,
  passwordResetTemplate,
  paymentReminderTemplate,
  refundIssuedTemplate,
  registrationPromotedTemplate,
  registrationTemplate,
  sponsorInvoiceTemplate,
  sponsorReceiptTemplate,
  sponsorRefundTemplate,
  verificationTemplate,
} from "../email-templates";
import { standingsTable } from "../email-templates/compose";
import type { Dict } from "@/lib/i18n";
import { buildPseudoDictionary } from "@/lib/pseudo";
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

// Each entry pairs a builder (built from `dict`) with the dict key that supplies
// its subject line — the localization regression overrides that key and asserts
// the output follows (the pre-i18n templates ignored the dict entirely).
function makeBuilders(
  dict: Dict,
): [string, { subject: string; html: string; text: string }, string][] {
  return [
    ["verification", verificationTemplate(LINK, dict), "verification.subject"],
    ["password-reset", passwordResetTemplate(LINK, dict), "passwordReset.subject"],
    ["magic-link", magicLinkTemplate(LINK, dict), "magicLink.subject"],
    ["email-change-confirm", emailChangeConfirmTemplate(LINK, dict), "emailChangeConfirm.subject"],
    [
      "email-change-notice",
      emailChangeNoticeTemplate("new@example.com", dict),
      "emailChangeNotice.subject",
    ],
    ["account-deletion", accountDeletionTemplate(dict), "accountDeletion.subject"],
    ["invite", inviteTemplate("Riverside Racquets", LINK, dict), "invite.subject"],
    ["registration", registrationTemplate(registrationArgs, dict), "registration.subject"],
    ["payment-reminder", paymentReminderTemplate(registrationArgs, dict), "paymentReminder.subject"],
    [
      "registration-promoted",
      registrationPromotedTemplate(
        {
          ...registrationArgs,
          payUrl: LINK,
          payDeadline: "2026-08-01T12:00:00Z",
          refCode: "SZ-ABCD-EFGH",
          refStatusUrl: "https://seazn.club/r/SZ-ABCD-EFGH",
        },
        dict,
      ),
      "registrationPromoted.subject",
    ],
    [
      "refund-issued",
      refundIssuedTemplate(
        {
          orgName: "Riverside Racquets",
          competitionName: "Spring Open 2026",
          displayName: "Alex",
          amountCents: 2500,
          currency: "gbp",
          refCode: "SZ-ABCD-EFGH",
        },
        dict,
      ),
      "refundIssued.subject",
    ],
    [
      "dispute-alert",
      disputeAlertTemplate(
        {
          orgName: "Riverside Racquets",
          competitionName: "Spring Open 2026",
          displayName: "Alex",
          amountCents: 2500,
          currency: "gbp",
          refCode: "SZ-ABCD-EFGH",
        },
        dict,
      ),
      "disputeAlert.subject",
    ],
    [
      "dispute-lost",
      disputeLostTemplate(
        {
          orgName: "Riverside Racquets",
          competitionName: "Spring Open 2026",
          displayName: "Alex",
          amountCents: 2500,
          currency: "gbp",
          refCode: "SZ-ABCD-EFGH",
          recoveredCents: 2375,
          consoleUrl: LINK,
        },
        dict,
      ),
      "disputeLost.subject",
    ],
    [
      "sponsor-invoice",
      sponsorInvoiceTemplate(
        {
          orgName: "Riverside Racquets",
          packageName: "Gold — Spring Open",
          sponsorName: "Court & Co <Ltd>",
          amountCents: 25_000,
          currency: "gbp",
          checkoutUrl: LINK,
        },
        dict,
      ),
      "sponsorInvoice.subject",
    ],
    [
      "sponsor-receipt",
      sponsorReceiptTemplate(
        {
          orgName: "Riverside Racquets",
          packageName: "Gold — Spring Open",
          sponsorName: "Court & Co <Ltd>",
          amountCents: 25_000,
          currency: "gbp",
          publicUrl: "https://seazn.club/shared/riverside",
        },
        dict,
      ),
      "sponsorReceipt.subject",
    ],
    [
      "sponsor-refund",
      sponsorRefundTemplate(
        {
          orgName: "Riverside Racquets",
          packageName: "Gold — Spring Open",
          sponsorName: "Court & Co <Ltd>",
          amountCents: 25_000,
          currency: "gbp",
        },
        dict,
      ),
      "sponsorRefund.subject",
    ],
    [
      "official-invite",
      officialInviteTemplate(
        { orgName: "Riverside Racquets", personName: "Priya <Ref>", claimUrl: LINK },
        dict,
      ),
      "officialInvite.subject",
    ],
    [
      "official-assigned",
      officialAssignedTemplate(
        {
          orgName: "Riverside Racquets",
          officialName: "Priya",
          meUrl: LINK,
          fixtures: [
            {
              label: "A & Co <vs> B",
              role_key: "referee",
              scheduled_at: "2026-08-01T09:00:00Z",
              venue_tz: "Europe/London",
              venue: "Main Hall",
              court_label: "Court 1",
            },
          ],
        },
        dict,
      ),
      "officialAssigned.subject",
    ],
    [
      "official-assignment-changed",
      officialAssignmentChangedTemplate(
        {
          orgName: "Riverside Racquets",
          officialName: "Priya",
          roleKey: "referee",
          label: "A vs B",
          prevAt: "2026-08-01T09:00:00Z",
          nextAt: "2026-08-01T11:30:00Z",
          venueTz: "Europe/London",
          court: "Court 2",
          venue: "Main Hall",
          meUrl: LINK,
        },
        dict,
      ),
      "officialChanged.subject",
    ],
  ];
}

const allBuilders = makeBuilders(emailsEn as Dict);

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
      // No i18n placeholder leaks (an un-passed {var} would).
      expect(out.subject).not.toMatch(/\{\w+\}/);
      // Plain-text part still populated.
      expect(out.text.length).toBeGreaterThan(10);
      expect(out.subject.length).toBeGreaterThan(5);
    });
  }

  it("every builder reads the provided dict, not hardcoded English", () => {
    for (const [name, , subjectKey] of allBuilders) {
      const marker = `SUBJ_${name.toUpperCase()}`;
      const fr = { ...(emailsEn as Dict), [subjectKey]: marker } as Dict;
      const [, out] = makeBuilders(fr).find(([n]) => n === name)!;
      expect(out.subject).toBe(marker);
    }
  });

  // Email-side equivalent of the SEAZN_PSEUDO Playwright audit: build every
  // template from the en-XA pseudo dict; all copy must be ⟦…⟧-wrapped, so any
  // un-extracted (hardcoded) English string would leak through un-wrapped.
  it("pseudolocale audit: all copy comes from the dict, nothing hardcoded", () => {
    const pseudo = buildPseudoDictionary(emailsEn as Dict) as Dict;
    for (const [name, out] of makeBuilders(pseudo)) {
      expect(out.subject.startsWith("⟦"), `${name}: subject not from dict`).toBe(true);
      expect(out.html, `${name}: body copy not from dict`).toContain("⟦");
    }
  });

  it("card registration carries a Pay now button and the deadline", () => {
    const out = registrationTemplate(
      {
        ...registrationArgs,
        paymentInstructions: null,
        payUrl: "https://checkout.stripe.test/cs_1",
        payDeadline: "2026-08-01T12:00:00Z",
      },
      emailsEn as Dict,
    );
    expect(out.html).toContain("https://checkout.stripe.test/cs_1");
    expect(out.html).toContain("Pay now");
    expect(out.text).toContain("https://checkout.stripe.test/cs_1");
  });

  it("card payment reminder links the fresh checkout, offline keeps instructions", () => {
    const card = paymentReminderTemplate(
      {
        ...registrationArgs,
        paymentInstructions: null,
        checkoutUrl: "https://checkout.stripe.test/cs_2",
        payDeadline: "2026-08-01T12:00:00Z",
      },
      emailsEn as Dict,
    );
    expect(card.html).toContain("https://checkout.stripe.test/cs_2");
    const offline = paymentReminderTemplate(registrationArgs, emailsEn as Dict);
    expect(offline.html).toContain("Bank transfer");
  });

  it("dispute-lost email states the loss, the balance debit and who pays the fee", () => {
    const out = disputeLostTemplate(
      {
        orgName: "O", competitionName: "C", displayName: "D",
        amountCents: 2000, currency: "gbp", refCode: "SZ-XXXX-YYYY",
        recoveredCents: 1900, consoleUrl: LINK,
      },
      emailsEn as Dict,
    );
    expect(out.subject.toLowerCase()).toContain("dispute lost");
    expect(out.text).toContain("SZ-XXXX-YYYY");
    expect(out.text).toContain("£20.00"); // disputed amount
    expect(out.text).toContain("£19.00"); // recovered from the club's balance
    expect(out.text.toLowerCase()).toContain("stripe balance");
    expect(out.text.toLowerCase()).toContain("dispute fee");
    expect(out.html).toContain(`href="${LINK}"`);
    // Recovery failed → no false claim that money moved.
    const failed = disputeLostTemplate(
      {
        orgName: "O", competitionName: "C", displayName: "D",
        amountCents: 2000, currency: "gbp", refCode: null,
        recoveredCents: 0, consoleUrl: LINK,
      },
      emailsEn as Dict,
    );
    expect(failed.text.toLowerCase()).not.toContain("recovered from your stripe balance");
  });

  it("refund email states the amount; dispute alert warns the organiser", () => {
    const refund = refundIssuedTemplate(
      {
        orgName: "O", competitionName: "C", displayName: "D",
        amountCents: 1234, currency: "gbp", refCode: null,
      },
      emailsEn as Dict,
    );
    expect(refund.text).toContain("12.34");
    const dispute = disputeAlertTemplate(
      {
        orgName: "O", competitionName: "C", displayName: "D",
        amountCents: 1234, currency: "gbp", refCode: "SZ-XXXX-YYYY",
      },
      emailsEn as Dict,
    );
    expect(dispute.subject.toLowerCase()).toContain("dispute");
    expect(dispute.text).toContain("SZ-XXXX-YYYY");
  });

  it("CTA builders carry the link in a button href", () => {
    for (const t of [
      verificationTemplate(LINK, emailsEn as Dict),
      passwordResetTemplate(LINK, emailsEn as Dict),
      magicLinkTemplate(LINK, emailsEn as Dict),
      emailChangeConfirmTemplate(LINK, emailsEn as Dict),
      inviteTemplate("Org", LINK, emailsEn as Dict),
      registrationTemplate(registrationArgs, emailsEn as Dict),
    ]) {
      expect(t.html).toContain(`href="${LINK}"`);
    }
  });

  it("registration escapes user-supplied names in the html", () => {
    const out = registrationTemplate(
      {
        ...registrationArgs,
        competitionName: 'Spring <script>alert("x")</script>',
        displayName: "A & B",
      },
      emailsEn as Dict,
    );
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).toContain("A &amp; B");
  });

  it("registration renders fee panel with instructions preserved", () => {
    const out = registrationTemplate(registrationArgs, emailsEn as Dict);
    expect(out.html).toContain("Entry fee: £25.00");
    expect(out.html).toContain(">Bank transfer\nRef: SPRING</p>");
  });

  it("registration carries the reference number + status link in html AND text (v3/05 §3)", () => {
    const out = registrationTemplate(
      {
        ...registrationArgs,
        refCode: "SZ-ABCD-EFG2",
        refStatusUrl: "https://seazn.club/r/SZ-ABCD-EFG2",
      },
      emailsEn as Dict,
    );
    expect(out.html).toContain("SZ-ABCD-EFG2");
    expect(out.html).toContain("https://seazn.club/r/SZ-ABCD-EFG2");
    expect(out.text).toContain("Your reference: SZ-ABCD-EFG2");
    expect(out.text).toContain("https://seazn.club/r/SZ-ABCD-EFG2");
    // Rows without a ref (pre-v2) keep the old shape — no dangling label.
    expect(registrationTemplate(registrationArgs, emailsEn as Dict).text).not.toContain(
      "Your reference",
    );
  });

  it("registration waitlist variant drops the fee panel", () => {
    const out = registrationTemplate(
      { ...registrationArgs, status: "waitlisted" },
      emailsEn as Dict,
    );
    expect(out.html).toContain("on the waitlist");
    expect(out.html).not.toContain("Entry fee");
  });

  it("payment reminder without instructions points at the organiser", () => {
    const out = paymentReminderTemplate(
      { ...registrationArgs, paymentInstructions: null },
      emailsEn as Dict,
    );
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
