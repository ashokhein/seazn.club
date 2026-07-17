import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityCard } from "@/components/ui/entity-card";

// Regression (fix-ui audit 02-console-org.md + 03-console-division.md):
// truncated card name and "Next: …" line had no `title` attribute, so the
// full text wasn't recoverable on hover once ellipsized.
describe("EntityCard — truncated text has a hover tooltip", () => {
  it("puts the full name in a title attribute on the name span", () => {
    const html = renderToStaticMarkup(
      <EntityCard
        href="/x"
        name="Open Singles Championship Division"
        chip={null}
        next="Arun vs Dev · Court 2 · 14:30, a very long fixture description that will truncate"
      />,
    );
    expect(html).toContain('title="Open Singles Championship Division"');
    expect(html).toContain(
      'title="Arun vs Dev · Court 2 · 14:30, a very long fixture description that will truncate"',
    );
  });
});
