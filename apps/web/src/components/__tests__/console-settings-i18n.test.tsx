import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OrgLogo } from "../org-logo";
import { TourReplayButton } from "../tour-replay";
import { DictProvider } from "@/components/i18n/dict-provider";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// Representative of the console feature-page i18n sweep: the settings
// sub-components read their copy from the active `ui` dict (useMsg), not
// hardcoded English. tsc + the full unit suite cover the rest of the batch.
const stub = {
  "settings.org.logo.title": "LOGO-TITLE-XX",
  "settings.org.logo.desc1": "LOGO-DESC1-XX",
  "settings.org.logo.desc2": "LOGO-DESC2-XX",
  "settings.org.logo.aria": "LOGO-ARIA-XX",
  "settings.org.tour.desc": "TOUR-DESC-XX",
  "settings.org.tour.replay": "TOUR-REPLAY-XX",
};

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <DictProvider dict={stub} locale="fr">
      {node}
    </DictProvider>,
  );

describe("console settings i18n", () => {
  it("OrgLogo reads its copy from the dict", () => {
    const html = render(<OrgLogo orgId="o1" initialLogoUrl={null} />);
    expect(html).toContain("LOGO-TITLE-XX");
    expect(html).toContain("LOGO-DESC1-XX");
    expect(html).not.toContain("Organisation logo");
  });

  it("TourReplayButton reads its copy from the dict", () => {
    const html = render(<TourReplayButton />);
    expect(html).toContain("TOUR-DESC-XX");
    expect(html).toContain("TOUR-REPLAY-XX");
    expect(html).not.toContain("Replay tour");
  });
});
