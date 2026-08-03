// W5 (#400) — the JR/FINAL marker, once.
//
// It was written twice, byte-identical, in `ai-diff-panel.tsx` and
// `ai-review-panel.tsx`. Two copies of a badge is how a board ends up with a
// purple FINAL on one card and a slate one on the next, so this pins the one
// definition both panels now import.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Marker } from "../ai-marker";

describe("Marker", () => {
  it("wears purple for a final and sky for a junior", () => {
    const final = renderToStaticMarkup(<Marker kind="FN" />);
    expect(final).toContain("FINAL");
    expect(final).toContain("bg-purple-100");
    expect(final).toContain("text-purple-700");

    const junior = renderToStaticMarkup(<Marker kind="JR" />);
    expect(junior).toContain("JR");
    expect(junior).toContain("bg-sky-100");
    expect(junior).toContain("text-sky-700");
  });

  // A marker sits beside a truncating matchup. Let it shrink and a long name
  // squeezes "FINAL" down to an ellipsis at 375px.
  it("never shrinks", () => {
    expect(renderToStaticMarkup(<Marker kind="FN" />)).toContain("shrink-0");
  });
});
