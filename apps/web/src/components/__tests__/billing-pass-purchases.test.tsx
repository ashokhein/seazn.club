// <BillingPassPurchases> — what the org actually bought, on the billing page
// (Task 14, and the rung it names since v17 #294).
//
// The failure being fixed here: `getPassPurchases` never selected `pass_key`,
// so this list rendered a $29 Event Pass M and a $59 Event Pass L as the same
// row. The money column cannot make up for it — `amountMinor` is null for a
// staff-granted pass and null again whenever the Stripe invoice read failed,
// which are precisely the rows a reader has least else to go on.
//
// Rendered through react-dom/server (node env, no DOM), like the sibling
// pass-component suites: this section has no effects.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingPassPurchases } from "@/components/billing-pass-purchases";
import { PASS_RUNG_NAME_KEY, passActiveLabel } from "@/lib/pass-ladder";
import { PASS_KEYS, type PassKey } from "@/lib/currency";
import { t } from "@/lib/i18n-runtime";
import enUi from "@/dictionaries/en/ui.json";
import type { PassPurchaseRow } from "@/server/usecases/billing-manage";

// Read from the dictionary the component reads, so a copy change reaches this
// file instead of a literal here going quietly stale.
const NAME = (key: PassKey) => t(enUi, PASS_RUNG_NAME_KEY[key]);

function row(over: Partial<PassPurchaseRow> = {}): PassPurchaseRow {
  return {
    competitionId: "c1",
    competitionName: "Summer League",
    competitionSlug: "summer-league",
    passKey: "event_pass",
    purchasedIso: "2026-05-05T09:00:00.000Z",
    amountMinor: 2900,
    currency: "usd",
    hostedInvoiceUrl: "https://invoice.stripe.test/i/summer",
    ended: false,
    ...over,
  };
}

const render = (rows: PassPurchaseRow[]) =>
  renderToStaticMarkup(
    <BillingPassPurchases
      rows={rows}
      orgSlug="riverside"
      locale="en"
      dict={enUi}
      invoicesListed
    />,
  );

describe("BillingPassPurchases", () => {
  it("names the competition and links at it", () => {
    const html = render([row()]);
    expect(html).toContain("Summer League");
    expect(html).toContain('href="/o/riverside/c/summer-league"');
  });

  it("names the RUNG each purchase was, both ways round", () => {
    // Both arms: a list hardcoded to either rung satisfies one of them.
    const m = render([row({ passKey: "event_pass" })]);
    expect(m).toContain(NAME("event_pass"));
    expect(m).not.toContain(NAME("event_pass_l"));

    const l = render([row({ passKey: "event_pass_l", amountMinor: 5900 })]);
    expect(l).toContain(NAME("event_pass_l"));
  });

  it("distinguishes two purchases of DIFFERENT rungs in one list", () => {
    // The real billing page: an org that bought both. Before #294 these two
    // rows were textually identical apart from the competition name.
    const html = render([
      row({ competitionId: "c1", competitionName: "Small Open", passKey: "event_pass" }),
      row({
        competitionId: "c2",
        competitionName: "Big Open",
        competitionSlug: "big-open",
        passKey: "event_pass_l",
        amountMinor: 5900,
      }),
    ]);
    for (const key of PASS_KEYS) expect(html).toContain(`data-pass-rung="${key}"`);
  });

  it("still names the rung when there is no amount to show", () => {
    // A staff grant was never charged, and a failed Stripe read reports no
    // amount either. Those rows used to carry a date and nothing else.
    const html = render([
      row({ passKey: "event_pass_l", amountMinor: null, currency: null, hostedInvoiceUrl: null }),
    ]);
    expect(html).toContain(NAME("event_pass_l"));
    expect(html).not.toContain("$");
  });

  it("pins the rung to the KEY, not only to its label", () => {
    // A rename of `upgrade.rung.l` must not be able to empty the negative
    // assertions above without anything going red.
    expect(render([row({ passKey: "event_pass_l" })])).toContain(
      'data-pass-rung="event_pass_l"',
    );
  });

  it("renders nothing when the org holds no pass", () => {
    expect(render([])).toBe("");
  });
});

describe("BillingPassPurchases — Active/Ended badge (v17 gap #301)", () => {
  // `getPassPurchases` has computed `row.ended` correctly since SPEC-4
  // (billing-manage.ts:425, via `isPassLocked`) and NOTHING rendered it. So the
  // one page that lists what an org has bought showed a pass whose competition
  // finished last season identically to one still lifting limits today — on the
  // screen where someone is deciding whether to spend more.
  const ACTIVE_M = passActiveLabel(enUi, "event_pass");
  const ACTIVE_L = passActiveLabel(enUi, "event_pass_l");
  const ENDED = t(enUi, "pass.entry.ended");

  it("marks a still-applying pass active", () => {
    const html = render([row({ ended: false })]);
    expect(html).toContain(ACTIVE_M);
    expect(html).not.toContain(ENDED);
  });

  it("marks a locked pass ended, not active", () => {
    const html = render([row({ ended: true })]);
    expect(html).toContain(ENDED);
    expect(html).not.toContain(ACTIVE_M);
  });

  it("carries a stable per-row status hook distinguishing the two", () => {
    expect(render([row({ ended: false })])).toContain('data-pass-status="active"');
    expect(render([row({ ended: true })])).toContain('data-pass-status="ended"');
  });

  it("badges each row independently — one ended pass does not tar the others", () => {
    // The real shape of this list: an org accumulates passes season after
    // season, so a MIXED list is the ordinary case, not the edge one.
    const html = render([
      row({ competitionId: "c1", competitionName: "Summer League", ended: true }),
      row({
        competitionId: "c2",
        competitionName: "Winter Cup",
        competitionSlug: "winter-cup",
        ended: false,
      }),
    ]);
    expect(html).toContain('data-pass-status="ended"');
    expect(html).toContain('data-pass-status="active"');
    expect(html).toContain("Summer League");
    expect(html).toContain("Winter Cup");
  });

  it("names the RUNG on the active badge, so L is not badged as M", () => {
    // #294's rule applied to this badge too: a flat "Event Pass active" tells a
    // $59 buyer they hold the $29 product.
    const l = render([row({ passKey: "event_pass_l", ended: false })]);
    expect(l).toContain(ACTIVE_L);
    expect(l).not.toContain(ACTIVE_M);
  });

  it("leaves no un-substituted placeholder in the badge", () => {
    // `pass.entry.active` is "{rung} active". Read through `t()` directly —
    // which is what this task's brief specified — it renders that brace to a
    // customer. `passActiveLabel` is the reason it cannot.
    for (const ended of [false, true]) {
      expect(render([row({ ended })])).not.toContain("{rung}");
    }
  });

  it("keeps the rung line and the date beside the badge", () => {
    const html = render([row({ ended: true })]);
    expect(html).toContain('data-pass-rung="event_pass"');
    // Formatted the way the component formats it rather than re-typed: the
    // literal depends on the ICU locale data, so a hardcoded "5 May 2026" is a
    // test that fails on the runtime rather than on the code.
    const shown = new Date("2026-05-05T09:00:00.000Z").toLocaleDateString("en", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    expect(html).toContain(shown);
  });
});
