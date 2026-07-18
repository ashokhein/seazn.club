import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ServePips } from "@/components/discipline/serve-pips";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

const dict = uiEn as unknown as Dict;

function render(served: number, total: number): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <ServePips served={served} total={total} />
    </DictProvider>,
  );
}

describe("ServePips", () => {
  it("renders one pip per match with N filled", () => {
    const html = render(2, 3);
    const filled = (html.match(/data-filled="1"/g) ?? []).length;
    const empty = (html.match(/data-filled="0"/g) ?? []).length;
    expect(filled).toBe(2);
    expect(empty).toBe(1);
  });

  it("carries an accessible label with the served count", () => {
    const html = render(2, 3);
    expect(html).toContain("2 of 3 matches served");
    expect(html).toContain('role="img"');
  });

  it("never shows more filled pips than the total (clamps overflow)", () => {
    const html = render(5, 2);
    const filled = (html.match(/data-filled="1"/g) ?? []).length;
    expect(filled).toBe(2);
    expect(html).toContain("2 of 2 matches served");
  });
});
