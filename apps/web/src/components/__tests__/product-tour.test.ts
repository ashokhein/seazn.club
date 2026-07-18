// Product-tour flow contract: the onboarding walk must run
// org → rename → get paid (Stripe Connect) → plan & billing → create a
// competition. The Connect and Billing stops were added between renaming the
// org and creating the first competition; this pins that order and the anchors
// each step highlights so a reorder or a renamed data-tour target trips here.
import { describe, expect, it, vi } from "vitest";

// product-tour.tsx is a client component; stub the navigation hooks so importing
// the module (for its STEPS table) never touches a real router.
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => {} }),
}));

import { STEPS, placeTooltip } from "@/components/product-tour";
import { routes } from "@/lib/routes";

describe("product tour flow", () => {
  it("walks org → get paid → billing → create competition, in order", () => {
    expect(STEPS.map((s) => s.id)).toEqual([
      "welcome",
      "org-chip",
      "org-rename",
      "connect",
      "billing",
      "new-competition",
      "wizard",
    ]);
  });

  it("the Connect step lives on the payments page and highlights the Stripe card", () => {
    const connect = STEPS.find((s) => s.id === "connect")!;
    expect(connect.target).toBe("connect-stripe");
    expect(connect.path("acme")).toBe(routes.connect("acme"));
  });

  it("the Billing step lives on the billing page and highlights the plan card", () => {
    const billing = STEPS.find((s) => s.id === "billing")!;
    expect(billing.target).toBe("billing-plan");
    expect(billing.path("acme")).toBe(routes.billing("acme"));
  });

  it("get paid then billing sit between renaming the org and creating a competition", () => {
    const idx = (id: string) => STEPS.findIndex((s) => s.id === id);
    expect(idx("org-rename")).toBeLessThan(idx("connect"));
    expect(idx("connect")).toBeLessThan(idx("billing"));
    expect(idx("billing")).toBeLessThan(idx("new-competition"));
  });
});

describe("tour tooltip placement", () => {
  // The Connect step highlights the whole Stripe card (~484px). On a phone
  // (667px tall) that fits neither below nor above the target, so the tooltip
  // must centre instead of rendering off-screen — the bug the mobile pass found.
  it("centres for a target taller than the viewport", () => {
    const style = placeTooltip({ top: 12, left: 24, width: 320, height: 484 }, 375, 667);
    expect(style.transform).toBe("translate(-50%, -50%)");
    expect(style.top).toBe("50%");
    expect(style.bottom).toBeUndefined();
  });

  it("places below when the target leaves room beneath it", () => {
    const style = placeTooltip({ top: 100, left: 40, width: 200, height: 40 }, 1280, 800);
    expect(style.top).toBe(100 + 40 + 16);
    expect(style.transform).toBeUndefined();
  });

  it("places above when there is room over the target but not under it", () => {
    const style = placeTooltip({ top: 600, left: 40, width: 200, height: 40 }, 1280, 667);
    expect(style.bottom).toBe(667 - 600 + 16);
    expect(style.top).toBeUndefined();
  });

  it("centres when there is no target (hidden on mobile)", () => {
    expect(placeTooltip(null, 375, 667).transform).toBe("translate(-50%, -50%)");
  });
});
