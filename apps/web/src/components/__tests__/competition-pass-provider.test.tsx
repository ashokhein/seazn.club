// Event Pass client state (v3/07 §3, task 16). The competition layout resolves
// `competition_passes` once and provides the answer; islands read it with
// usePassActive(). Rendered through react-dom/server (node env, no DOM), the
// same way dict-provider.test.tsx exercises the other console context.
//
// The contract that matters to callers is the DEFAULT: org-level pages never
// mount this provider, and a gate rendering there must keep behaving exactly as
// it does today. So "outside a competition" has to read as `false`, not throw
// and not undefined.
import { describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CompetitionPassProvider,
  usePassActive,
  usePassCurrency,
  usePassGateState,
  usePassLockReason,
  usePassRung,
} from "@/components/competition-pass-provider";

function Probe() {
  return <span id="p">{`pass:${usePassActive()}`}</span>;
}

function StateProbe() {
  return <span id="s">{`state:${usePassGateState()}`}</span>;
}

function RungProbe() {
  return <span id="r">{`rung:${usePassRung()}`}</span>;
}

function CurrencyProbe() {
  return <span id="c">{`currency:${usePassCurrency()}`}</span>;
}

function ReasonProbe() {
  return <span id="lr">{`reason:${usePassLockReason()}`}</span>;
}

describe("CompetitionPassProvider / usePassActive", () => {
  it("defaults to false outside a competition, without throwing", () => {
    // An UpgradeGate on /o/[orgSlug]/settings/billing has no provider above it.
    // Unlike useT(), that is a normal place to render — never a wiring bug — so
    // the hook must answer rather than blow up the page.
    expect(renderToStaticMarkup(<Probe />)).toContain("pass:false");
  });

  it("reports true inside a competition the org holds a pass for", () => {
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey="event_pass">
        <Probe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("pass:true");
  });

  it("reports false inside a competition with no pass", () => {
    // The control arm: without it the assertion above would still pass if the
    // hook simply answered true once a provider existed.
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey={null}>
        <Probe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("pass:false");
  });

  it("keeps answering the pass-ROW question under a paid plan", () => {
    // usePassActive() is still "is there a competition_passes row", never
    // "should the gate offer a pass". Collapsing the two here would make the
    // hook lie to any future caller that asks about the purchase itself.
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey="event_pass" paidPlan>
        <Probe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("pass:true");
  });

  it("reaches islands nested arbitrarily deep", () => {
    // Gates render several levels under the layout (page → card → toolbar), so
    // the value has to travel by context, not by prop drilling one level.
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey="event_pass">
        <div>
          <section>
            <Probe />
          </section>
        </div>
      </CompetitionPassProvider>,
    );
    expect(html).toContain("pass:true");
  });
});

// The gate does not want two booleans, it wants ONE answer about which upsell
// is honest here. Deciding that in the hook means the precedence — a paid plan
// makes the pass moot, exactly as lib/entitlements.ts decides it — is written
// down once instead of at every gate.
describe("usePassGateState", () => {
  const state = (node: ReactNode) => renderToStaticMarkup(node);

  it("is 'none' outside a competition", () => {
    expect(state(<StateProbe />)).toContain("state:none");
  });

  it("is 'none' for a community org with no pass", () => {
    const html = state(
      <CompetitionPassProvider passKey={null} paidPlan={false}>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:none");
  });

  it("is 'held' for a community org that bought the pass", () => {
    const html = state(
      <CompetitionPassProvider passKey="event_pass" paidPlan={false}>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:held");
  });

  it("is 'paid_plan' for a paid org with no pass", () => {
    const html = state(
      <CompetitionPassProvider passKey={null} paidPlan>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:paid_plan");
  });

  it("prefers 'paid_plan' when the org holds a pass AND a paid plan", () => {
    // Buy a pass, then upgrade: the row survives the upgrade. The resolver
    // stops consulting the pass at that point, so the pass can no longer be
    // the reason anything is blocked.
    const html = state(
      <CompetitionPassProvider passKey="event_pass" paidPlan>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:paid_plan");
  });

  it("defaults paidPlan to false when the prop is omitted", () => {
    // The safe default: a caller that forgets the plan gets today's behaviour
    // (offer the pass), never a silently suppressed upsell for a paying org.
    const html = state(
      <CompetitionPassProvider passKey={null}>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:none");
  });

  // v17 gap #301. "held" used to mean nothing more than "a row exists", so a
  // pass whose competition had finished — one the resolver had ALREADY stopped
  // honouring (SPEC-4 §7) — read identically to one still applying, and every
  // gate under this provider said "Event Pass active" to an org back on
  // Community caps.
  it("is 'ended' when a pass is held and locked", () => {
    const html = state(
      <CompetitionPassProvider passKey="event_pass" paidPlan={false} lockReason="terminal">
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:ended");
  });

  it("is 'held' — not 'ended' — when a pass is held and nothing locked it", () => {
    // The control arm: without it the case above would still pass if the hook
    // simply answered "ended" to every held pass.
    const html = state(
      <CompetitionPassProvider passKey="event_pass" paidPlan={false} lockReason={null}>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:held");
  });

  it("defaults lockReason to null when the prop is omitted — existing call sites keep meaning 'held'", () => {
    // Same safe-default contract as paidPlan, the other way round: a caller
    // that forgets this prop must not have a live pass silently declared dead.
    const html = state(
      <CompetitionPassProvider passKey="event_pass" paidPlan={false}>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:held");
  });

  it("prefers 'paid_plan' over an ended pass — the plan still wins over everything", () => {
    // Precedence is decided in ONE place. A paid org's gate was closed by its
    // PLAN's ceiling, so neither "held" nor "ended" may explain it.
    const html = state(
      <CompetitionPassProvider passKey="event_pass" paidPlan lockReason="past_ends_on">
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:paid_plan");
  });

  it("is 'closed' for a lock reason with no pass row — never 'ended' (#376)", () => {
    // This case used to be pinned as `none`, on the reading that a lock needs a
    // purchase to lock. It does not: the lock is a fact about the COMPETITION,
    // and `none` put the buy chip on a sale the checkout answers with 410 Gone.
    // Still not `ended` either — nothing was bought, so there is no purchase to
    // report as stopped, which is exactly the gap `closed` fills. Uses the
    // `past_ends_on` arm so both reasons are covered across the two describes.
    const html = state(
      <CompetitionPassProvider passKey={null} lockReason="past_ends_on">
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:closed");
  });
});

// #376. The layout INNER-joined through `competition_passes`, so a competition
// with no pass row returned no row at all and `lockReason` was structurally
// unreachable — which made "no pass + locked" look like nonsense input rather
// than the ordinary state of every finished competition nobody bought a pass
// for. With the LEFT JOIN it is reachable, and it needs a name of its own.
describe("usePassGateState — the closed state (#376)", () => {
  const state = (node: ReactNode) => renderToStaticMarkup(node);

  it("is `closed` when the competition is locked and no pass was held", () => {
    const html = state(
      <CompetitionPassProvider
        passKey={null}
        paidPlan={false}
        lockReason="terminal"
        sellableRungs={[]}
      >
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:closed");
  });

  it("is still `none` when nothing is locked and no pass is held", () => {
    // The control arm: `closed` must key on the LOCK, not merely on the absence
    // of a pass, or every community competition on the product goes quiet.
    const html = state(
      <CompetitionPassProvider
        passKey={null}
        paidPlan={false}
        lockReason={null}
        sellableRungs={["event_pass"]}
      >
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:none");
  });

  // A paid plan already suppresses the chip and `paid_plan` is not a lie about
  // a closed competition, so it keeps winning.
  it("yields to paid_plan", () => {
    const html = state(
      <CompetitionPassProvider
        passKey={null}
        paidPlan
        lockReason="terminal"
        sellableRungs={[]}
      >
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:paid_plan");
  });

  it("leaves a HELD locked pass as `ended`", () => {
    // `closed` takes only the no-pass arm. An org that DID buy has a purchase
    // to be told about, and `ended` is the sentence that tells it.
    const html = state(
      <CompetitionPassProvider
        passKey="event_pass"
        paidPlan={false}
        lockReason="past_ends_on"
        sellableRungs={[]}
      >
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:ended");
  });
});

// The REASON, not just the yes/no (v17 gap #301): the surfaces in Tasks 3-6
// have to tell "this competition finished" from "it simply ran past its end
// date", and neither the wording nor the CTA is the same for both. Computed by
// `passLockReason` server-side — this only carries it.
describe("usePassLockReason", () => {
  it("is null outside a competition", () => {
    expect(renderToStaticMarkup(<ReasonProbe />)).toContain("reason:null");
  });

  it("is null inside a competition whose pass still applies", () => {
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey="event_pass">
        <ReasonProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("reason:null");
  });

  it("surfaces the exact reason the provider was given, both arms", () => {
    // Both arms, because "reports past_ends_on" proves nothing if the hook
    // answers past_ends_on to everything — the same shape as the bug being
    // fixed, with the literal the other way round.
    for (const reason of ["terminal", "past_ends_on"] as const) {
      const html = renderToStaticMarkup(
        <CompetitionPassProvider passKey="event_pass" lockReason={reason}>
          <ReasonProbe />
        </CompetitionPassProvider>,
      );
      expect(html, reason).toContain(`reason:${reason}`);
    }
  });

  it("still reports the reason under a paid plan", () => {
    // Same contract as usePassActive/usePassRung: this answers the PASS's own
    // question. The "what should we say here" precedence stays in
    // usePassGateState, which reports paid_plan for this input.
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey="event_pass" paidPlan lockReason="terminal">
        <ReasonProbe />
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("reason:terminal");
    expect(html).toContain("state:paid_plan");
  });
});

// The rung, added by v17 #294. `usePassActive()` answers "is there a row" and
// nothing more; with M ($29) and L ($59) both live, every surface that says a
// pass is on and cannot say WHICH one is naming M's product to an L buyer.
describe("usePassRung", () => {
  it("is null outside a competition", () => {
    expect(renderToStaticMarkup(<RungProbe />)).toContain("rung:null");
  });

  it("is null inside a competition that holds no pass", () => {
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey={null}>
        <RungProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("rung:null");
  });

  it("reports the rung the competition actually holds", () => {
    // Both arms, because "reports L" proves nothing if the hook answers L to
    // everything — which is precisely the shape of the bug being fixed, with
    // the literal the other way round.
    for (const rung of ["event_pass", "event_pass_l"] as const) {
      const html = renderToStaticMarkup(
        <CompetitionPassProvider passKey={rung}>
          <RungProbe />
        </CompetitionPassProvider>,
      );
      expect(html).toContain(`rung:${rung}`);
    }
  });

  it("still reports the rung under a paid plan", () => {
    // Same contract as usePassActive(): this is the ROW's own question. The
    // "should we offer/advertise it" precedence lives in usePassGateState.
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey="event_pass_l" paidPlan>
        <RungProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("rung:event_pass_l");
  });

  it("agrees with usePassActive in both directions", () => {
    // Two hooks, ONE field — the whole reason the provider carries a rung
    // instead of a boolean beside a rung that can disagree with it.
    const both = (passKey: "event_pass_l" | null) =>
      renderToStaticMarkup(
        <CompetitionPassProvider passKey={passKey}>
          <Probe />
          <RungProbe />
        </CompetitionPassProvider>,
      );
    expect(both("event_pass_l")).toContain("pass:true");
    expect(both(null)).toContain("pass:false");
  });
});

// The currency, also #294. `preferredCurrency` is a server resolution (the
// org's subscription, then the switcher cookie, then Accept-Language) and no
// client island can compute any of it — which is why the paywall quoted a
// hardcoded "usd" to a £-paying organiser for as long as it has existed.
describe("usePassCurrency", () => {
  it("is usd outside a competition — today's behaviour, not a crash", () => {
    expect(renderToStaticMarkup(<CurrencyProbe />)).toContain("currency:usd");
  });

  it("defaults to usd when the prop is omitted", () => {
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey={null}>
        <CurrencyProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("currency:usd");
  });

  it("carries the currency the org is actually charged in", () => {
    const html = renderToStaticMarkup(
      <CompetitionPassProvider passKey={null} currency="gbp">
        <CurrencyProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("currency:gbp");
  });
});
