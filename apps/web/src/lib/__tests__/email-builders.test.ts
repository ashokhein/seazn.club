// Every email builder now composes from the HTML files in email-templates/html.
// These tests fail against the old string-literal card() templates: they assert
// the courtside shell (slab masthead, preheader, court line), escaping of
// user-supplied content, and that no {{TOKEN}} leaks into a sent email.
import { describe, expect, it } from "vitest";
import {
  accountDeletionTemplate,
  emailChangeConfirmTemplate,
  emailChangeNoticeTemplate,
  inviteTemplate,
  magicLinkTemplate,
  passwordResetTemplate,
  paymentReminderTemplate,
  registrationTemplate,
  verificationTemplate,
} from "../email-templates";
import { standingsTable } from "../email-templates/compose";

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
  ["verification", verificationTemplate(LINK)],
  ["password-reset", passwordResetTemplate(LINK)],
  ["magic-link", magicLinkTemplate(LINK)],
  ["email-change-confirm", emailChangeConfirmTemplate(LINK)],
  ["email-change-notice", emailChangeNoticeTemplate("new@example.com")],
  ["account-deletion", accountDeletionTemplate()],
  ["invite", inviteTemplate("Riverside Racquets", LINK)],
  ["registration", registrationTemplate(registrationArgs)],
  ["payment-reminder", paymentReminderTemplate(registrationArgs)],
];

describe("email builders compose from the html templates", () => {
  for (const [name, out] of allBuilders) {
    it(`${name}: courtside shell, no unresolved tokens, non-empty text`, () => {
      // Slab masthead + court line come from base.html only.
      expect(out.html).toContain('bgcolor="#231738"');
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

  it("CTA builders carry the link in a button href", () => {
    for (const t of [
      verificationTemplate(LINK),
      passwordResetTemplate(LINK),
      magicLinkTemplate(LINK),
      emailChangeConfirmTemplate(LINK),
      inviteTemplate("Org", LINK),
      registrationTemplate(registrationArgs),
    ]) {
      expect(t.html).toContain(`href="${LINK}"`);
    }
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
