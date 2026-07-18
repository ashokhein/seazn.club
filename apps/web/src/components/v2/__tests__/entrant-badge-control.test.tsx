import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EntrantBadgeControl } from "@/components/v2/entrants-panel";

// F4 — static markup like the sibling panel tests; interactions are covered
// by the API route tests (setEntrantBadge) and the smoke suite.

const base = { id: "e1", display_name: "Mexico" };

describe("EntrantBadgeControl", () => {
  it("with a badge: preview image + Replace + Remove", () => {
    const html = renderToStaticMarkup(
      <EntrantBadgeControl
        entrant={{ ...base, badge_url: "https://flags.example/mx.png" }}
        canEdit
        busy={false}
        onBadge={() => {}}
      />,
    );
    expect(html).toContain('src="https://flags.example/mx.png"');
    expect(html).toContain("Replace");
    expect(html).toContain("Remove");
    expect(html).toContain('aria-label="Badge for Mexico"');
  });

  it("without a badge: monogram + Upload, no Remove", () => {
    const html = renderToStaticMarkup(
      <EntrantBadgeControl entrant={{ ...base, badge_url: null }} canEdit busy={false} onBadge={() => {}} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain(">M<"); // monogram initial
    expect(html).toContain("Upload");
    expect(html).not.toContain("Remove");
  });

  it("read-only: preview only, no controls", () => {
    const html = renderToStaticMarkup(
      <EntrantBadgeControl
        entrant={{ ...base, badge_url: "https://flags.example/mx.png" }}
        canEdit={false}
        busy={false}
        onBadge={() => {}}
      />,
    );
    expect(html).toContain('src="https://flags.example/mx.png"');
    expect(html).not.toContain("Replace");
    expect(html).not.toContain("type=\"file\"");
  });
});
