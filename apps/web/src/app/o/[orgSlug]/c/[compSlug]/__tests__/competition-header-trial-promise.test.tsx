// The competition header's Event Pass entry point (task 19) passes
// `goProLabel={t(dict, "upgrade.proCard.cta")}` straight to
// `<CompetitionPassEntry>`, which renders it verbatim inside the "ended" pass
// card (v17 gap #354). That string reads "Go Pro — 14-day free trial" and
// must not be shown to an org that has already spent its one trial
// (`subscriptions.trial_used_at`, V304/#190) — the checkout will not grant a
// second one (`checkoutTrialDays` in lib/billing.ts).
//
// Rendered through react-dom/server (no jsdom in this workspace, same pattern
// as upgrade-page.test.tsx). The page is called directly to get its resolved
// element, then wrapped in the REAL <CompetitionPassProvider> the competition
// layout would mount in production — the "ended" gate branch that carries
// `goProLabel` cannot render at all without it, so this is the smallest render
// that actually exercises the code path the fix touches.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  // v17 gap #354: null means this org has not spent its one trial.
  trialUsedAt: null as string | null,
}));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside" },
    competition: { id: "comp-1", name: "Summer League", slug: "summer-league" },
    canEdit: true,
  }),
}));

vi.mock("@/server/usecases/competitions", () => ({
  getCompetition: async () => ({
    id: "comp-1",
    org_id: "org-1",
    name: "Summer League",
    slug: "summer-league",
    description: null,
    starts_on: null,
    ends_on: null,
    visibility: "private",
    branding: null,
    status: "live",
    created_at: new Date().toISOString(),
    discoverable: false,
    discovery: null,
    frozen: false,
  }),
}));
vi.mock("@/server/usecases/divisions", () => ({ listDivisions: async () => [] }));
vi.mock("@/server/usecases/card-stats", () => ({
  listDivisionCardStats: async () => new Map(),
  nextLine: () => null,
  formatLabel: () => null,
}));
vi.mock("@/server/public-site/data", () => ({ resolveLogoUrl: () => null }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));

// The trial read the page adds (v17 gap #354) — same org→subscription join
// shape as upgrade/page.tsx, mocked here rather than hit against a real DB.
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray | unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    return Promise.resolve([{ trial_used_at: h.trialUsedAt }]);
  },
}));
// Fully mocked like upgrade-page.test.tsx's own `@/lib/billing` double —
// reproducing the real predicate's exact shape rather than importing the
// real module (which drags in Stripe/db/email at import time).
vi.mock("@/lib/billing", () => ({
  checkoutTrialDays: (sub?: { trial_used_at: string | null }) => (sub?.trial_used_at ? 0 : 14),
}));

import Page from "../page";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

beforeEach(() => {
  h.trialUsedAt = null;
});

/**
 * Renders the page wrapped in the real provider, forced into the "ended" gate
 * — the only branch of `<CompetitionPassEntry>` that shows `goProLabel` — so
 * the assertions are about the actual prop the page computed, not a stand-in.
 */
async function renderEnded(): Promise<string> {
  const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }) });
  return renderToStaticMarkup(
    <CompetitionPassProvider passKey="event_pass" paidPlan={false} lockReason="terminal">
      {el}
    </CompetitionPassProvider>,
  );
}

describe("competition header — the Go Pro trial promise (v17 gap #354)", () => {
  it("still promises the trial for an org that has not spent it", async () => {
    const html = await renderEnded();
    expect(html).toContain("data-pass-ended-pro");
    expect(html).toContain(t(uiEn, "upgrade.proCard.cta"));
  });

  it("drops the trial clause once trial_used_at is set", async () => {
    h.trialUsedAt = "2026-01-01T00:00:00.000Z";
    const html = await renderEnded();
    expect(html).toContain("data-pass-ended-pro");
    expect(html).not.toContain(t(uiEn, "upgrade.proCard.cta"));
    expect(html).toContain(t(uiEn, "upgrade.proCard.ctaNoTrial"));
    expect(html).not.toContain("free trial");
  });
});
