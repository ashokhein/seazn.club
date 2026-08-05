// <CompetitionPassEntry> — the Event Pass, offered BEFORE the refusal
// (task 19, spec D3).
//
// The failure being fixed: `routes.competitionUpgrade` had exactly one inbound
// link in the whole app — the paywall in <UpgradeGate>. A community organiser
// could only discover the pass by first being blocked by a limit, which is the
// worst possible moment to meet a price.
//
// The THREE failures this must NOT reintroduce, all three already paid for once:
//
//   paid_plan → the pass grants strictly LESS than any paid plan: Pro's matrix
//               is a superset of it at every key the pass lifts. Offering it
//               there sells a downgrade. That was live in the gate until
//               f70b8e52; a brand-new surface is exactly where it comes back.
//   held      → never re-sell a pass the org already owns. Presence is ROW
//               EXISTENCE, never payment: a staff-granted pass carries a null
//               `stripe_payment_intent` and is fully active.
//   ended     → a pass whose competition finished, or ran past its end date plus
//               grace, has STOPPED applying (SPEC-4 §7): the resolver is back on
//               Community caps for it. Saying "Event Pass M active" there was the
//               literal v17 gap #301 P1 defect — and, once `usePassGateState()`
//               learned the state, saying nothing at all would drop the org
//               straight onto the BUY link for a pass it already owns and can
//               never repurchase. Both lies are asserted against below.
//
// Rendered through react-dom/server, like competition-pass-provider.test.tsx:
// the suite runs in the node environment and this island has no effects.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";
import { CompetitionPassEntry } from "@/components/competition-pass-entry";
import { passActiveLabels, passEndedReasons } from "@/lib/pass-ladder";
import { t } from "@/lib/i18n-runtime";
import type { PassKey } from "@/lib/currency";
// Type-only: `@/lib/entitlements` is a server module (postgres + ioredis) and a
// VALUE import of it would drag both into this suite for the sake of a union.
import type { PassLockReason } from "@/lib/entitlements";
import uiEn from "@/dictionaries/en/ui.json";

const HREF = "/o/riverside/c/summer-league/upgrade";
// "from" since v17 #294: two rungs are live and $29 is the ladder's FLOOR, not
// the price. The label the page builds is `pass.entry.buy`.
const BUY = "Event Pass — from $29 one-time";
// Built the way the pages build it, so a dictionary change reaches this file
// rather than a literal here going quietly stale.
const ACTIVE_LABELS = passActiveLabels(uiEn);
const ACTIVE = ACTIVE_LABELS.event_pass;
// Same reasoning as ACTIVE_LABELS: built the way the pages build them, so the
// approved dictionary wording reaches this file instead of a literal here going
// stale the first time the sentence is corrected.
const ENDED = t(uiEn, "pass.entry.ended");
const ENDED_REASONS = passEndedReasons(uiEn);
const NEXT_EDITION_HREF = "/o/riverside/c/new";
const NEXT_EDITION = t(uiEn, "pass.entry.ended.nextEdition");
const GO_PRO_HREF = "/o/riverside/settings/billing";
const GO_PRO = t(uiEn, "upgrade.proCard.cta");
// #376 — the `closed` state's one link, per lock reason. Built the way both
// pages build it (routes.competitionNew / routes.competitionSettings, and the
// two dictionary keys), so the two arms lead to genuinely different places and
// a card that hardcoded either one fails the other.
const SETTINGS_HREF = "/o/riverside/c/summer-league/settings";
const UPDATE_END_DATE = t(uiEn, "pass.entry.closed.updateEndDate");
const CLOSED_LINKS: Record<PassLockReason, { href: string; label: string }> = {
  terminal: { href: NEXT_EDITION_HREF, label: NEXT_EDITION },
  past_ends_on: { href: SETTINGS_HREF, label: UPDATE_END_DATE },
};

/**
 * The rendered markup, with react-dom's text-node escaping undone.
 *
 * Every assertion in this file is about COPY or about markup STRUCTURE, never
 * about encoding — and an apostrophe is enough to break both directions of
 * that. "Create next year's edition" arrives as `year&#x27;s`, which fails a
 * positive `toContain` loudly and, far worse, makes a NEGATIVE one pass
 * vacuously. Two of the four locales' new strings carry apostrophes
 * (fr "l'année", "n'est"), so this is not a one-string workaround.
 */
const decode = (html: string) =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

function render({
  passKey = null,
  paidPlan = false,
  lockReason = null,
  canBuy = true,
  closedLinks = CLOSED_LINKS,
}: {
  passKey?: PassKey | null;
  paidPlan?: boolean;
  lockReason?: PassLockReason | null;
  canBuy?: boolean;
  closedLinks?: Record<PassLockReason, { href: string; label: string }>;
} = {}) {
  return decode(
    renderToStaticMarkup(
      <CompetitionPassProvider passKey={passKey} paidPlan={paidPlan} lockReason={lockReason}>
        <CompetitionPassEntry
          href={HREF}
          buyLabel={BUY}
          activeLabels={ACTIVE_LABELS}
          endedLabel={ENDED}
          endedReasons={ENDED_REASONS}
          nextEditionHref={NEXT_EDITION_HREF}
          nextEditionLabel={NEXT_EDITION}
          goProHref={GO_PRO_HREF}
          goProLabel={GO_PRO}
          canBuy={canBuy}
          closedLinks={closedLinks}
        />
      </CompetitionPassProvider>,
    ),
  );
}

describe("CompetitionPassEntry", () => {
  it("offers the pass to a community org that does not hold one", () => {
    const html = render();
    expect(html).toContain(`href="${HREF}"`);
    expect(html).toContain(BUY);
  });

  it("is a link into the competition's own upgrade page, not the billing page", () => {
    // The whole point of the task: a SECOND inbound link to
    // routes.competitionUpgrade. Sending the reader to /settings/billing would
    // land them on Pro — a subscription — which is not what the column offers.
    expect(render()).not.toContain("/settings/billing");
  });

  it("shows the active signal, and no price, once the org holds the pass", () => {
    const html = render({ passKey: "event_pass" });
    expect(html).toContain(ACTIVE);
    expect(html).not.toContain(HREF);
    expect(html).not.toContain("$29");
  });

  it("names the RUNG that is held, not the product family", () => {
    // v17 #294. This eyebrow is the only thing the competition's own chrome
    // says about its pass, so "Event Pass active" over an `event_pass_l` row
    // tells a $59 buyer they hold the $29 product. Both arms, because a card
    // hardcoded the other way would satisfy either one alone.
    const m = render({ passKey: "event_pass" });
    expect(m).toContain(ACTIVE_LABELS.event_pass);
    expect(m).not.toContain(ACTIVE_LABELS.event_pass_l);

    const l = render({ passKey: "event_pass_l" });
    expect(l).toContain(ACTIVE_LABELS.event_pass_l);
    expect(l).not.toContain(ACTIVE_LABELS.event_pass);
  });

  it("carries the rung as an attribute, not only as copy", () => {
    // Pinned to the KEY so a rename of the label cannot silently empty the
    // assertions above, and so e2e can assert the rung without matching prose.
    expect(render({ passKey: "event_pass_l" })).toContain('data-pass-held-rung="event_pass_l"');
    expect(render({ passKey: "event_pass" })).toContain('data-pass-held-rung="event_pass"');
  });

  it("leaves no un-substituted placeholder in the held signal", () => {
    // `t()` renders a forgotten interpolation var as the literal `{rung}`.
    expect(render({ passKey: "event_pass_l" })).not.toContain("{rung}");
  });

  it("still shows the active signal to a viewer who cannot buy", () => {
    // "This competition has a pass" is a fact about the competition, not an
    // invitation — a scorer looking at a passed competition should see it.
    const html = render({ passKey: "event_pass", canBuy: false });
    expect(html).toContain(ACTIVE);
  });

  it("renders NOTHING for an org already on a paid plan", () => {
    // A Pro org has no pass row, so a naive "is there a pass?" boolean reads
    // false here and the $29 CTA appears — selling less than they already hold.
    expect(render({ paidPlan: true })).toBe("");
  });

  it("renders nothing for a paid org that also happens to hold a pass", () => {
    // Bought a pass, then upgraded: the row survives. The resolver stops
    // consulting it, so advertising it would name the wrong reason anything
    // works. usePassGateState collapses this to paid_plan; so does this.
    expect(render({ passKey: "event_pass", paidPlan: true })).toBe("");
  });

  it("offers nothing to a viewer who cannot buy and holds no pass", () => {
    expect(render({ canBuy: false })).toBe("");
  });

  it("does not answer to the paywall's [data-pass-cta] selector", () => {
    // pricing-v3.spec.ts asserts `[data-pass-cta]` has count 0 under a
    // competition whose pass is held — the proof that the gate stopped
    // re-selling it. A discovery link wearing that attribute would break that
    // proof on any page where both render.
    expect(render()).not.toContain("data-pass-cta");
    expect(render()).toContain("data-pass-entry");
  });

  it("reads 'none' — and therefore offers the pass — with no provider above it", () => {
    // Nothing should mount this outside a competition, but if something does,
    // the safe default is today's behaviour, not a crash.
    const html = decode(
      renderToStaticMarkup(
      <CompetitionPassEntry
        href={HREF}
        buyLabel={BUY}
        activeLabels={ACTIVE_LABELS}
        endedLabel={ENDED}
        endedReasons={ENDED_REASONS}
        nextEditionHref={NEXT_EDITION_HREF}
        nextEditionLabel={NEXT_EDITION}
        goProHref={GO_PRO_HREF}
        goProLabel={GO_PRO}
        canBuy
        closedLinks={CLOSED_LINKS}
      />,
      ),
    );
    expect(html).toContain(BUY);
  });
});

// ===========================================================================
// v17 gap #301 P1 — the pass that has stopped applying.
//
// Two opposite lies live either side of this branch, and both have been real
// code on this file: "Event Pass M active" over a pass the resolver stopped
// honouring (the shipped defect), and — the moment `usePassGateState()` learned
// to say "ended" without this component learning to render it — the BUY link,
// offering a $29 purchase the API refuses outright (pass-checkout/route.ts
// refuses on an existing `competition_passes` row, and that table's PK is
// `competition_id` alone). Every case below pins one side or the other.
// ===========================================================================
describe("CompetitionPassEntry — ended", () => {
  it("shows the ended signal instead of 'active' once the pass is locked", () => {
    const html = render({ passKey: "event_pass", lockReason: "terminal" });
    expect(html).toContain(ENDED);
    expect(html).not.toContain(ACTIVE);
    expect(html).not.toContain(ACTIVE_LABELS.event_pass_l);
  });

  it("never re-offers the purchase — no price, no link, no CTA hook", () => {
    // The regression this task exists to close: `ended` falling through the
    // `held` branch lands on the buy link, which is a dead end (the checkout
    // route refuses) AND an implicit claim that the org does not already own it.
    const html = render({ passKey: "event_pass", lockReason: "past_ends_on" });
    expect(html).not.toContain("$29");
    expect(html).not.toContain(`href="${HREF}"`);
    expect(html).not.toContain("data-pass-cta");
    expect(html).not.toContain("data-pass-entry");
    expect(html).not.toContain(BUY);
  });

  it("names the terminal reason distinctly from the past-ends-on reason", () => {
    // Collapsing the two is how an organiser whose only problem is a stale end
    // date gets told their competition is over.
    const terminal = render({ passKey: "event_pass", lockReason: "terminal" });
    const pastEnds = render({ passKey: "event_pass", lockReason: "past_ends_on" });
    expect(terminal).toContain(ENDED_REASONS.terminal);
    expect(pastEnds).toContain(ENDED_REASONS.past_ends_on);
    expect(terminal).not.toContain(ENDED_REASONS.past_ends_on);
    expect(pastEnds).not.toContain(ENDED_REASONS.terminal);
  });

  // EXHAUSTIVE over the reason set, not over the two arms someone remembered.
  // `passEndedReasons` returns a `Record<PassLockReason, string>`, so a third
  // reason added to PASS_LOCK_REASONS appears here the day it is written — and
  // this is the assertion that would catch it rendering nothing.
  it.each(Object.keys(ENDED_REASONS) as PassLockReason[])(
    "renders the ended card, with its own sentence, for lock reason %s",
    (reason) => {
      const html = render({ passKey: "event_pass", lockReason: reason });
      expect(html).toContain("data-pass-ended");
      expect(ENDED_REASONS[reason].length, `${reason} has no sentence`).toBeGreaterThan(20);
      expect(html).toContain(ENDED_REASONS[reason]);
      expect(html).not.toContain(`href="${HREF}"`);
    },
  );

  it("offers a fresh next-year competition, never a copy of this one", () => {
    // routes.competitionNew — the blank form. There is no copy-competition
    // feature, so a link claiming to duplicate this one would be a promise the
    // product cannot keep.
    const html = render({ passKey: "event_pass", lockReason: "terminal" });
    expect(html).toContain(`href="${NEXT_EDITION_HREF}"`);
    expect(html).toContain(NEXT_EDITION);
  });

  it("offers Go Pro alongside the next-edition link", () => {
    // The pass is gone and cannot come back for THIS competition; a plan is the
    // only thing that lifts it now, which makes this the one honest upsell here.
    const html = render({ passKey: "event_pass", lockReason: "terminal" });
    expect(html).toContain(`href="${GO_PRO_HREF}"`);
    expect(html).toContain(GO_PRO);
  });

  it("shows the ended state regardless of canBuy — a fact, not an invitation", () => {
    const html = render({ passKey: "event_pass", lockReason: "terminal", canBuy: false });
    expect(html).toContain(ENDED);
    expect(html).toContain("data-pass-ended");
  });

  it("carries its own data hook, distinct from the held pill", () => {
    const html = render({ passKey: "event_pass", lockReason: "terminal" });
    expect(html).toContain("data-pass-ended");
    expect(html).not.toContain("data-pass-held");
  });

  it("renders nothing for a paid org whose (dormant) pass is also locked", () => {
    // Belt and braces: paid_plan must win even when BOTH other facts are set.
    // A paid org is not being sold anything here and is not owed an epitaph for
    // a pass its plan has long since exceeded.
    expect(render({ passKey: "event_pass", paidPlan: true, lockReason: "terminal" })).toBe("");
  });

  it("invents no ENDED card when a lock reason arrives with no pass row", () => {
    // Precedence lives in usePassGateState (passKey before lockReason) and this
    // is the surface half of it. The half that is still true, and the reason
    // this case is kept: a competition that never held a pass must NOT render
    // the ended card — that card reports a purchase that stopped applying, and
    // there was no purchase.
    //
    // The other half — "so it reads 'none' and keeps offering the buy link" —
    // was the #376 defect, asserted here as intent. It was written before v17
    // gap #353 made the checkout route the authority, and the reasoning it
    // carried (a direct link deserves a control that explains itself rather
    // than a page that never mentions the pass) survives #376 intact; what
    // changed is WHICH control does the explaining. The chip led to a checkout
    // that answers 410 Gone, so the reader had to spend a click to learn the
    // sale was off. The `closed` state below says it on the page and offers the
    // one next step that can still help.
    const html = render({ lockReason: "terminal" });
    expect(html).not.toContain("data-pass-ended");
    expect(html).not.toContain(ENDED);
    expect(html).not.toContain(BUY);
    expect(html).not.toContain("data-pass-entry");
  });
});

// ===========================================================================
// #376 — the competition is past the pass line and NEVER held a pass.
//
// `none` swallowed this whole, so the buy chip linked to a checkout that
// answers 410 Gone: a purchase offered, clicked, and refused. `ended` is the
// wrong card in the other direction — it reports a purchase that stopped
// applying, and there was never a purchase here. The `closed` state is one
// editor-gated link, chosen by lock reason, and the two arms lead to genuinely
// different places.
// ===========================================================================
describe("CompetitionPassEntry — closed (#376)", () => {
  it("renders no buy chip for a locked competition that never held a pass", () => {
    const html = render({ lockReason: "terminal" });
    expect(html).not.toContain("data-pass-entry");
    expect(html).not.toContain(`href="${HREF}"`);
    expect(html).not.toContain(BUY);
    expect(html).not.toContain("$29");
  });

  it("points a finished competition at next season", () => {
    const html = render({ lockReason: "terminal" });
    expect(html).toContain("data-pass-closed-link");
    expect(html).toContain(`href="${NEXT_EDITION_HREF}"`);
    expect(html).toContain(NEXT_EDITION);
    // The Record lookup is real, not a hardcoded arm: the OTHER destination
    // must be absent, or a card that always links to settings passes above.
    expect(html).not.toContain(`href="${SETTINGS_HREF}"`);
    expect(html).not.toContain(UPDATE_END_DATE);
  });

  // The recoverable arm. A stale end date is usually a typo on a competition
  // still being played — fix it and the pass is buyable again, so pointing
  // this organiser at NEXT season would be the wrong next step entirely.
  it("points a past-end-date competition at its settings, not at next season", () => {
    const html = render({ lockReason: "past_ends_on" });
    expect(html).toContain(`href="${SETTINGS_HREF}"`);
    expect(html).toContain(UPDATE_END_DATE);
    expect(html).not.toContain(`href="${NEXT_EDITION_HREF}"`);
    expect(html).not.toContain(NEXT_EDITION);
  });

  // EXHAUSTIVE over the reason set rather than over the two arms someone
  // remembered — `closedLinks` is a `Record<PassLockReason, …>`, so a third
  // reason appears here the day it is written, and this is the assertion that
  // catches it rendering nothing.
  it.each(Object.keys(CLOSED_LINKS) as PassLockReason[])(
    "renders one link, its own, for lock reason %s",
    (reason) => {
      const html = render({ lockReason: reason });
      expect(html).toContain(`data-pass-closed-reason="${reason}"`);
      expect(html).toContain(`href="${CLOSED_LINKS[reason].href}"`);
      expect(html).toContain(CLOSED_LINKS[reason].label);
    },
  );

  it("shows nothing to a viewer who cannot act on it", () => {
    // Editor-gated, unlike the ended card. That card shows to everyone because
    // it is a FACT about the competition; this state's entire content is an
    // action link, and a lone link shown to someone who can neither create a
    // competition nor edit its dates is noise, not information.
    expect(render({ lockReason: "terminal", canBuy: false })).toBe("");
    expect(render({ lockReason: "past_ends_on", canBuy: false })).toBe("");
  });

  it("says nothing about a pass, because none was ever bought", () => {
    const html = render({ lockReason: "terminal" });
    expect(html).not.toContain("data-pass-ended");
    expect(html).not.toContain(ENDED);
    expect(html).not.toContain(ENDED_REASONS.terminal);
    expect(html).not.toContain("data-pass-held");
    expect(html).not.toContain(ACTIVE);
  });

  it("keeps the paid plan winning — a paid org is sold nothing here", () => {
    // Precedence: paid_plan beats the lock, exactly as it beats held/ended.
    expect(render({ paidPlan: true, lockReason: "terminal" })).toBe("");
  });

  it("gives the link a 44px touch target", () => {
    // Mobile is not optional: the tappable box is min-h-11 (44px) with a
    // compensating negative margin so the chip keeps its optical position.
    const html = render({ lockReason: "terminal" });
    // Anchored on whitespace/quote rather than `\b`: there is no word boundary
    // between `"` and the leading `-` of `-my-1`, so `/\b-my-1\b/` cannot match
    // a class list that begins with it — a shape that reads correct and fails.
    expect(html).toMatch(/class="(?:[^"]*\s)?min-h-11[\s"]/);
    expect(html).toMatch(/class="(?:[^"]*\s)?-my-1[\s"]/);
  });
});
