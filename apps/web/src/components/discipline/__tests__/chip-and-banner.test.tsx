import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SuspensionChip } from "@/components/discipline/suspension-chip";
import { PadSuspensionBanner } from "@/components/discipline/pad-suspension-banner";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

const dict = uiEn as unknown as Dict;
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      {node}
    </DictProvider>,
  );

describe("SuspensionChip", () => {
  it("shows the count of active suspensions with a red glyph", () => {
    const html = wrap(
      <SuspensionChip suspensions={[{ personName: "A", remaining: 1 }, { personName: "B", remaining: 2 }]} />,
    );
    expect(html).toContain('data-testid="suspension-chip"');
    expect(html).toContain('data-tone="red"');
    expect(html).toContain("2 suspended");
    expect(html).toContain(">2<");
  });

  it("renders nothing when there are no suspensions", () => {
    const html = wrap(<SuspensionChip suspensions={[]} />);
    expect(html).toBe("");
  });
});

describe("PadSuspensionBanner", () => {
  it("reads one sentence with the name and served count", () => {
    const html = wrap(<PadSuspensionBanner name="J. Smith" served={1} total={2} />);
    expect(html).toContain('data-testid="pad-suspension-banner"');
    expect(html).toContain("J. Smith is suspended (1 of 2 served) — recording anyway.");
    expect(html).toContain('role="status"');
  });
});
