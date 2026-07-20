// Restore trial control (Task 6, v3/08 §1): the panel must expose the
// undo for one-trial-per-org, and it must show trial state HONESTLY — a
// departed org (status: canceled) can still carry a pro plan_key and a
// stamped trial_used_at, and neither fact should hide the other.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminPlanPanel } from "../admin-plan-panel";
import { ConfirmProvider } from "@/components/ui/confirm-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

interface TestPlan {
  plan_key: string;
  status: string;
  source: "stripe" | "comped" | "none";
  trial_end: string | null;
  comped_until: string | null;
  current_period_end: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_used_at: string | null;
}

const basePlan: TestPlan = {
  plan_key: "community",
  status: "active",
  source: "none",
  trial_end: null,
  comped_until: null,
  current_period_end: null,
  stripe_customer_id: null,
  stripe_subscription_id: null,
  trial_used_at: null,
};

function render(plan: TestPlan) {
  return renderToStaticMarkup(
    <ConfirmProvider>
      <AdminPlanPanel orgId="org-1" orgName="Test Org" plan={plan} overrides={[]} />
    </ConfirmProvider>,
  );
}

/** Isolate the HTML of the <button> whose text is `label`, so a `disabled`
 *  assertion can't accidentally pass off some OTHER button on the page (the
 *  panel starts with several disabled-until-reason-typed buttons). Anchored
 *  on the button's CLOSING form (`>${label}</button>`), not just `>${label}<`
 *  — each card's <h3> heading repeats the button's own label text and
 *  renders first, so a bare `>${label}<` match lands on the heading and the
 *  backward walk from there finds the PRECEDING card's button instead. The
 *  heading closes with `</h3>`, never `</button>`, so this string can only
 *  match the real button. */
function buttonHtmlFor(html: string, label: string): string {
  const closeTag = `>${label}</button>`;
  const closeIdx = html.indexOf(closeTag);
  if (closeIdx === -1) throw new Error(`button not found: ${label}`);
  const tagStart = html.lastIndexOf("<button", closeIdx);
  return html.slice(tagStart, closeIdx + closeTag.length);
}

/** True disabled-attribute check. React's static renderer emits a boolean
 *  `disabled` prop as the literal attribute `disabled=""` when true and
 *  omits it entirely when false — it never renders as `disabled:` (that's
 *  only the Tailwind class-variant prefix, e.g. `disabled:opacity-50`,
 *  which every button on this panel carries whether or not it is actually
 *  disabled). Matching on `disabled="` distinguishes the real attribute
 *  from that class string. */
function isReallyDisabled(buttonHtml: string): boolean {
  return /\bdisabled="/.test(buttonHtml);
}

describe("AdminPlanPanel — restore trial", () => {
  it("renders the Restore trial card, disabled until a reason is typed", () => {
    const html = render(basePlan);
    expect(html).toContain("Restore trial");
    expect(html).toContain("Clears the one-trial-per-org stamp");
    expect(isReallyDisabled(buttonHtmlFor(html, "Restore trial"))).toBe(true);
  });

  it("states plainly when there is nothing to restore", () => {
    const html = render(basePlan);
    expect(html).toContain("This org has not used its trial yet");
  });

  it("shows the trial-used date once the org has burned its trial", () => {
    const iso = "2026-02-15T00:00:00.000Z";
    const expected = new Date(iso).toLocaleDateString("en-GB");
    const html = render({ ...basePlan, trial_used_at: iso });
    expect(html).not.toContain("This org has not used its trial yet");
    expect(html).toContain(`Trial used ${expected}.`);
    // Plan summary badge, independent of the Restore trial card's own hint.
    expect(html).toContain(`trial used ${expected}`);
  });

  it("shows a departed org honestly: canceled status, a leftover pro plan_key, AND the trial-used date all at once", () => {
    const iso = "2026-01-05T00:00:00.000Z";
    const expected = new Date(iso).toLocaleDateString("en-GB");
    const html = render({
      ...basePlan,
      plan_key: "pro",
      status: "canceled",
      source: "comped",
      stripe_subscription_id: "sub_gone",
      trial_used_at: iso,
    });
    expect(html).toContain("pro");
    expect(html).toContain("status: canceled");
    expect(html).toContain(`Trial used ${expected}.`);
    // The Restore trial control must still render for this exact case (a
    // departed org keeps its dead stripe_subscription_id, which is exactly
    // what the usecase's docstring calls out as the case this hatch exists
    // for) — it must not be gated away by a presence-only Stripe check.
    expect(html).toContain("Restore trial");
    // Not just present — still correctly disabled (no reason typed yet),
    // even for this departed/leftover-plan combination. A regression that
    // dropped the disabled-until-reason guard specifically for this branch
    // would flip this from true to false.
    expect(isReallyDisabled(buttonHtmlFor(html, "Restore trial"))).toBe(true);
  });
});
