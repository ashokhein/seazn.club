import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { MarkTiles } from "@/components/officials/mark-tiles";

// No jsdom/@testing-library in this workspace (vitest env: node) — call the
// hook-free component directly and inspect the returned element's props, the
// established pattern (see run-your-own-cta.test.tsx).
type TileEl = ReactElement<{
  "data-mark": number;
  "aria-pressed": boolean;
  onClick: () => void;
  className: string;
}>;

function tiles(value: number | null, onSet: (n: number) => void) {
  const el = MarkTiles({ value, onSet }) as ReactElement<{
    onKeyDown: (e: { key: string; preventDefault: () => void }) => void;
    children: TileEl[];
  }>;
  return { el, buttons: el.props.children };
}

describe("MarkTiles (SPEC-3 signature: five scoreboard-digit tap targets)", () => {
  it("renders exactly five digit tiles, 1–5, and no star glyph", () => {
    const { buttons } = tiles(null, () => {});
    expect(buttons).toHaveLength(5);
    expect(buttons.map((b) => b.props["data-mark"])).toEqual([1, 2, 3, 4, 5]);
    const html = renderToStaticMarkup(<MarkTiles value={3} onSet={() => {}} />);
    expect(html).not.toContain("★");
    expect(html).not.toContain("<svg");
  });

  it("lights only the selected tile with aria-pressed", () => {
    const { buttons } = tiles(4, () => {});
    const four = buttons.find((b) => b.props["data-mark"] === 4)!;
    const three = buttons.find((b) => b.props["data-mark"] === 3)!;
    expect(four.props["aria-pressed"]).toBe(true);
    expect(three.props["aria-pressed"]).toBe(false);
    expect(four.props.className).toContain("bg-lime-400");
  });

  it("one tap fires onSet with that mark", () => {
    const onSet = vi.fn();
    const { buttons } = tiles(null, onSet);
    buttons.find((b) => b.props["data-mark"] === 4)!.props.onClick();
    expect(onSet).toHaveBeenCalledWith(4);
  });

  it("is keyboard operable — arrow keys move the selection", () => {
    const onSet = vi.fn();
    const { el } = tiles(4, onSet);
    el.props.onKeyDown({ key: "ArrowRight", preventDefault: () => {} });
    expect(onSet).toHaveBeenCalledWith(5);
    el.props.onKeyDown({ key: "ArrowLeft", preventDefault: () => {} });
    expect(onSet).toHaveBeenCalledWith(3);
  });

  it("every tile meets the 44px mobile tap-target bar", () => {
    const { buttons } = tiles(null, () => {});
    for (const b of buttons) {
      expect(b.props.className).toContain("min-h-[44px]");
      expect(b.props.className).toContain("min-w-[44px]");
    }
  });
});
