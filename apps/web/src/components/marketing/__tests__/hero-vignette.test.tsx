import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { HeroVignette } from "../hero-vignette";

// Node-env render contract; the replay interaction is covered by e2e.
describe("HeroVignette", () => {
  it("renders the scorebug end-state and a replay control", () => {
    const html = renderToStaticMarkup(<HeroVignette />);
    expect(html).toContain('data-testid="scorebug"');
    expect(html).toContain('aria-label="Replay animation"');
    expect(html).toContain("LIVE");
  });
  it("scorebug reads as cricket — batting side with runs/wicket", () => {
    // 142/3 is the SSR state; the +4 boundary tick on ball-landing is client
    // behaviour (covered visually), so the static markup pins the base score.
    const html = renderToStaticMarkup(<HeroVignette />);
    expect(html).toContain("Falcons CC 142/3");
  });
  it("keeps a fixed-height box so the hero cannot shift layout", () => {
    const html = renderToStaticMarkup(<HeroVignette />);
    expect(html).toMatch(/h-64|h-72/);
  });
});
