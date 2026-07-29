// Competition settings mounts the SAME Event Pass entry point as the
// competition header (task 19), with its own copy of
// `goProLabel={t(dict, "upgrade.proCard.cta")}` — "Go Pro — 14-day free
// trial", unconditionally, in the "ended" pass card (v17 gap #354). An org
// that already spent its one trial (`subscriptions.trial_used_at`, V304/#190)
// must not be shown that clause: the checkout will not grant a second one
// (`checkoutTrialDays` in lib/billing.ts).
//
// Same technique as competition-header-trial-promise.test.tsx: call the page
// directly to get its resolved element, then wrap it in the REAL
// <CompetitionPassProvider> the competition layout mounts in production,
// forced into the "ended" gate — the only branch that renders `goProLabel`.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  trialUsedAt: null as string | null,
}));

vi.mock("@/server/page-auth", () => ({
  requireCompetitionPage: async () => ({
    auth: { orgId: "org-1" },
    org: { id: "org-1", name: "Riverside CC", slug: "riverside", branding: null },
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
vi.mock("@/lib/entitlements", () => ({ hasFeature: async () => false }));
vi.mock("@/lib/currency-server", () => ({ preferredCurrency: async () => "usd" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
// The client form itself is not what this fix touches — stubbed so its own
// dependencies (a DictProvider context this render never mounts) cannot make
// an unrelated part of the tree the reason this test fails.
vi.mock("@/components/v2/competition-settings", () => ({
  CompetitionSettings: () => <div data-competition-settings-stub />,
}));
vi.mock("@/components/v2/archived-divisions", () => ({
  ArchivedDivisions: () => <div data-archived-divisions-stub />,
}));

// `withTenant`'s callback receives a tagged-template tx; the youth and
// fixture-aggregate queries this page also issues are answered generically so
// only the org→subscription trial read (v17 gap #354) needs a real branch.
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray | unknown[]) => {
    if (!Array.isArray(strings) || !("raw" in strings)) return { __fragment: strings };
    const text = (strings as TemplateStringsArray).join(" ");
    if (text.includes("organizations"))
      return Promise.resolve([{ trial_used_at: h.trialUsedAt }]);
    if (text.includes("eligibility")) return Promise.resolve([{ youth: false }]);
    return Promise.resolve([{ total: 0, underway: 0, done: 0, scheduled: 0 }]);
  };
  return { sql, withTenant: async (_orgId: string, cb: (tx: typeof sql) => unknown) => cb(sql) };
});
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

async function renderEnded(): Promise<string> {
  const el = await Page({ params: Promise.resolve({ orgSlug: "riverside", compSlug: "summer-league" }) });
  return renderToStaticMarkup(
    <CompetitionPassProvider passKey="event_pass" paidPlan={false} lockReason="terminal">
      {el}
    </CompetitionPassProvider>,
  );
}

describe("competition settings — the Go Pro trial promise (v17 gap #354)", () => {
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
