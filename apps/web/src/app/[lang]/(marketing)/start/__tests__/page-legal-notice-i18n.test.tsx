import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Regression for design/fix-ui/01-marketing-auth.md "[high] /start funnel step
// 3 — raw i18n key 'legal.notice.body' leaks": StartPage used to wrap its
// DictProvider in the `marketing`-only dict, which has zero legal.notice.*
// keys, so <LegalNotice/> (rendered inside <StartWizard/> at the final step)
// fell through i18n-runtime's last-resort fallback and printed the raw key
// instead of translated copy. Root cause was the wrong-scoped DictProvider,
// not a missing translation — so this test exercises the *real* StartPage
// dict-construction code path (not a hand-rolled stand-in), with only the
// step-navigation-heavy StartWizard swapped for a thin stub that renders the
// same <LegalNotice/> the real wizard renders on its final step.
vi.mock("@/components/marketing-nav", () => ({ MarketingNav: () => null }));
vi.mock("@/components/marketing-footer", () => ({ MarketingFooter: () => null }));
vi.mock("@/components/start-wizard", async () => {
  const { LegalNotice } = await import("@/components/legal-notice");
  return {
    StartWizard: () => <LegalNotice />,
  };
});

import StartPage from "../page";

async function renderStart(lang: "en" | "fr") {
  const el = await StartPage({
    params: Promise.resolve({ lang }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(el);
}

describe("/start funnel — LegalNotice i18n (DictProvider scope)", () => {
  it("renders real translated legal copy, not the raw key (en)", async () => {
    const html = await renderStart("en");
    expect(html).not.toContain("legal.notice.body");
    expect(html).toContain("By continuing, you agree to our");
    expect(html).toContain("Terms of Service");
    expect(html).toContain("Privacy Policy");
  });

  it("renders real translated legal copy, not the raw key (fr)", async () => {
    const html = await renderStart("fr");
    expect(html).not.toContain("legal.notice.body");
    expect(html).toContain("En continuant, vous acceptez nos");
    expect(html).toContain("Conditions d&#x27;utilisation");
    expect(html).toContain("Politique de confidentialité");
  });
});
