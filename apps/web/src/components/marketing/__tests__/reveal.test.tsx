import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Reveal } from "../reveal";

// Node-env render contract (repo has no jsdom): initial markup must show the
// pre-reveal state; the IntersectionObserver behavior is covered by e2e
// (marketing-home.spec.ts asserts .mk-in after scroll).
describe("Reveal", () => {
  it("renders pre-reveal state without mk-in", () => {
    const html = renderToStaticMarkup(<Reveal>hi</Reveal>);
    expect(html).toContain("mk-reveal");
    expect(html).not.toContain("mk-in");
    expect(html).toContain("hi");
  });

  it("supports the section tag and passes extra props through", () => {
    const html = renderToStaticMarkup(
      <Reveal as="section" className="x" data-testid="r">
        hi
      </Reveal>,
    );
    expect(html).toContain("<section");
    expect(html).toContain('data-testid="r"');
    expect(html).toContain("x");
  });
});
