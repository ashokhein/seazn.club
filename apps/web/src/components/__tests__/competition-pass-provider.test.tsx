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
  usePassGateState,
} from "@/components/competition-pass-provider";

function Probe() {
  return <span id="p">{`pass:${usePassActive()}`}</span>;
}

function StateProbe() {
  return <span id="s">{`state:${usePassGateState()}`}</span>;
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
      <CompetitionPassProvider active>
        <Probe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("pass:true");
  });

  it("reports false inside a competition with no pass", () => {
    // The control arm: without it the assertion above would still pass if the
    // hook simply answered true once a provider existed.
    const html = renderToStaticMarkup(
      <CompetitionPassProvider active={false}>
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
      <CompetitionPassProvider active paidPlan>
        <Probe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("pass:true");
  });

  it("reaches islands nested arbitrarily deep", () => {
    // Gates render several levels under the layout (page → card → toolbar), so
    // the value has to travel by context, not by prop drilling one level.
    const html = renderToStaticMarkup(
      <CompetitionPassProvider active>
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
      <CompetitionPassProvider active={false} paidPlan={false}>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:none");
  });

  it("is 'held' for a community org that bought the pass", () => {
    const html = state(
      <CompetitionPassProvider active paidPlan={false}>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:held");
  });

  it("is 'paid_plan' for a paid org with no pass", () => {
    const html = state(
      <CompetitionPassProvider active={false} paidPlan>
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
      <CompetitionPassProvider active paidPlan>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:paid_plan");
  });

  it("defaults paidPlan to false when the prop is omitted", () => {
    // The safe default: a caller that forgets the plan gets today's behaviour
    // (offer the pass), never a silently suppressed upsell for a paying org.
    const html = state(
      <CompetitionPassProvider active={false}>
        <StateProbe />
      </CompetitionPassProvider>,
    );
    expect(html).toContain("state:none");
  });
});
