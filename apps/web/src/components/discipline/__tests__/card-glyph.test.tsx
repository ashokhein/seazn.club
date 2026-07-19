import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CardGlyph, toneForColor, toneForSource } from "@/components/discipline/card-glyph";

describe("CardGlyph", () => {
  it("fills yellow #FBBF24 for the yellow tone", () => {
    const html = renderToStaticMarkup(<CardGlyph tone="yellow" />);
    expect(html).toContain("#FBBF24");
    expect(html).toContain('data-tone="yellow"');
  });

  it("fills red #ef4444 for the red tone", () => {
    const html = renderToStaticMarkup(<CardGlyph tone="red" />);
    expect(html).toContain("#ef4444");
    expect(html).toContain('data-tone="red"');
  });

  it("is decorative — aria-hidden, the row text carries meaning", () => {
    const html = renderToStaticMarkup(<CardGlyph tone="red" />);
    expect(html).toContain("aria-hidden");
  });

  it("maps card colour keys to a tone (second yellow is a sending-off → red)", () => {
    expect(toneForColor("yellow")).toBe("yellow");
    expect(toneForColor("second_yellow")).toBe("red");
    expect(toneForColor("red")).toBe("red");
    expect(toneForColor("game_misconduct")).toBe("red");
  });

  it("maps suspension source to a tone", () => {
    expect(toneForSource("auto_accumulation")).toBe("yellow");
    expect(toneForSource("auto_dismissal")).toBe("red");
    expect(toneForSource("manual")).toBe("red");
  });
});
