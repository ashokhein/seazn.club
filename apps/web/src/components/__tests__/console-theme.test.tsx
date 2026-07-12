import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusChip } from "@/components/ui/status-chip";
import { NightStage } from "@/components/night-stage";
import { Breadcrumbs } from "@/components/breadcrumbs";

vi.mock("next/navigation", () => ({
  usePathname: () => "/o/riverside/c/summer-open",
}));

// Floodlit-console pass (docs/superpowers/specs/2026-07-12): the night chrome
// render contracts. Interaction (menus, tour) stays with e2e.
describe("floodlit console theme", () => {
  it("LIVE chip is the floodlit scorebug: lime on night, lime dot", () => {
    const html = renderToStaticMarkup(<StatusChip state="live" />);
    expect(html).toContain('data-chip="live"');
    expect(html).toContain("bg-night");
    expect(html).toContain("text-lime-400");
    expect(html).toContain("bg-lime-400"); // the pulsing dot
    expect(html).not.toContain("bg-purple-600");
  });

  it("non-live chips keep their light styling", () => {
    const draft = renderToStaticMarkup(<StatusChip state="draft" />);
    expect(draft).toContain("bg-slate-100");
    const reg = renderToStaticMarkup(<StatusChip state="registration" />);
    expect(reg).toContain("text-purple-700");
  });

  it("breadcrumbs render as the night apron, not the old white strip", () => {
    const html = renderToStaticMarkup(
      <Breadcrumbs
        orgName="Riverside"
        orgs={[
          { name: "Riverside", slug: "riverside" },
          { name: "Northside", slug: "northside" },
        ]}
        names={{ comps: { "summer-open": "Summer Open" }, divs: {} }}
      />,
    );
    expect(html).toContain("app-crumbs");
    expect(html).toContain("text-cream");
    expect(html).not.toContain("bg-white");
    // Trail still derives from the pathname.
    expect(html).toContain("Summer Open");
    expect(html).toContain("Riverside");
  });

  it("night stage mounts the wordmark over its children", () => {
    const html = renderToStaticMarkup(
      <NightStage>
        <p>ticket window</p>
      </NightStage>,
    );
    expect(html).toContain("app-night-stage");
    expect(html).toContain("Seazn");
    expect(html).toContain("ticket window");
  });
});
