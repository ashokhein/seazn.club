import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StartFunnelForm } from "../start-funnel-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

describe("StartFunnelForm labels", () => {
  it("renders English defaults with no labels prop", () => {
    const html = renderToStaticMarkup(<StartFunnelForm />);
    expect(html).toContain("Players / teams");
    expect(html).toContain("Start date");
    expect(html).toContain("Setup →");
  });

  it("renders the localized labels a caller passes", () => {
    const html = renderToStaticMarkup(
      <StartFunnelForm
        labels={{
          sport: "SPORT-FR",
          entrants: "Joueurs / équipes",
          date: "Date de début",
          submit: "Configuration →",
        }}
      />,
    );
    expect(html).toContain("Joueurs / équipes");
    expect(html).toContain("Date de début");
    expect(html).toContain("Configuration →");
    expect(html).not.toContain("Players / teams");
    // Sport names stay canonical (they double as the query value).
    expect(html).toContain("Football");
  });
});
