import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketingFooter } from "@/components/marketing-footer";
import { funnelFormClasses } from "@/components/start-funnel-form";

// The footer now mounts the LocaleSwitcher, a client component using navigation
// hooks; stub them so the static-render contract test stays router-free (the
// switcher's behaviour is covered by e2e/i18n-switcher.spec.ts).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/en/start",
}));

// MarketingNav is an async server component (getCurrentUser) and the funnel
// form needs the app router mounted — both interaction paths are covered by
// e2e (marketing-home.spec.ts). Here: footer render contract + the pure
// variant-class logic.
describe("marketing shell pieces", () => {
  it("footer links the new product pages", () => {
    const html = renderToStaticMarkup(<MarketingFooter />);
    expect(html).toContain('href="/formats"');
    expect(html).toContain('href="/scheduling"');
    expect(html).toContain('href="/discover"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain("ANY SPORT · LIVE IN MINUTES");
  });
  it("funnel night variant adds the dark classes", () => {
    const cls = funnelFormClasses(false, "night");
    expect(cls).toContain("mk-funnel-night");
    expect(cls).not.toContain("border-purple-200");
  });
  it("funnel default stays light (existing pages unaffected)", () => {
    const cls = funnelFormClasses(false, "light");
    expect(cls).not.toContain("mk-funnel-night");
    expect(cls).toContain("border-purple-200");
    expect(cls).toContain("bg-white/80");
  });
});
