// Body copy for the staff alert sent when a refunded Event Pass credit could
// NOT be safely reversed (`reason: "undetermined"`, pass-credit.ts §5).
//
// The alert used to end at "nothing was automatically reversed", which reads
// like the only outstanding item is a number to check in Stripe. It isn't: the
// undetermined row goes on holding `pass_credit_redemptions_group_cap` (V337 /
// #286), so the billing group's ONE lifetime Event Pass credit is blocked for
// every org in it, and settling the customer's balance in Stripe does not
// release it — there is no self-serve release this wave. A staff member acting
// on the old wording would close the ticket with a customer silently unable to
// ever earn another pass credit.
//
// Internal staff alert: NOT localised (unlike the customer-facing builders in
// email-templates/, this one takes no `locale`/`Dict` and is composed inline in
// lib/email.ts), so English is the only copy to assert.
//
// Asserted through the real send path with `fetch` stubbed, because the body
// string is built inside the send function and there is no separate template
// export to call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendPassCreditReversalIncompleteAlertEmail } from "../email";

interface SentPayload {
  subject: string;
  html: string;
  text: string;
}

let sent: SentPayload[] = [];
const OLD_KEY = process.env.RESEND_API_KEY;

beforeEach(() => {
  sent = [];
  process.env.RESEND_API_KEY = "re_test_key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentPayload);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_KEY;
});

const base = {
  to: "ops@seazn.test",
  orgId: "org-123",
  orgName: "Riverside Racquets",
  competitionName: "Spring Open 2026",
  grantedMinor: 2500,
  currency: "gbp",
};

describe("pass credit reversal alert — undetermined", () => {
  it("says the group's lifetime credit is BLOCKED and cannot be released in Stripe", async () => {
    await sendPassCreditReversalIncompleteAlertEmail({
      ...base,
      reversedMinor: 0,
      reason: "undetermined",
    });

    expect(sent).toHaveLength(1);
    const { text, html } = sent[0]!;
    // The existing "nothing was reversed" line is not enough on its own — the
    // consequence has to be spelled out.
    expect(text).toContain("nothing was automatically reversed");
    expect(text.toLowerCase()).toContain("blocked");
    expect(text).toContain("lifetime Event Pass credit");
    // Settling the balance in Stripe is the obvious-but-wrong next step.
    expect(text).toContain("does NOT release it");
    // And there is no button anywhere that clears it today.
    expect(text).toContain("no self-serve way");
    // Same copy reaches the HTML part, not just the plain-text fallback.
    expect(html.toLowerCase()).toContain("blocked");
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("does NOT claim a block on the ordinary consumed-remainder alert", async () => {
    // "consumed" reversals did claw back what they could and cleared the cap;
    // telling staff that group is blocked would be a lie.
    await sendPassCreditReversalIncompleteAlertEmail({
      ...base,
      reversedMinor: 1000,
      reason: "consumed",
    });

    expect(sent).toHaveLength(1);
    const { text } = sent[0]!;
    expect(text.toLowerCase()).not.toContain("blocked");
    expect(text).toContain("written off");
  });
});
