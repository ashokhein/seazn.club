import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandColorPicker } from "@/components/brand-color-picker";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// Palette swatch names read swatch.<Name> from the active dictionary; the null
// "default" chip keeps its parent-provided label. Sentinel proves the wiring.
const dict: Dict = {
  ...(uiEn as unknown as Dict),
  "swatch.Teal": "«teal-loc»",
  "swatch.Crimson": "«crimson-loc»",
};

describe("brand colour picker swatch i18n", () => {
  it("localizes palette swatch names, keeps the default chip label", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="fr">
        <BrandColorPicker value={null} onSelect={() => {}} defaultLabel="Violet" />
      </DictProvider>,
    );
    expect(html).toContain("«teal-loc»");
    expect(html).toContain("«crimson-loc»");
    expect(html).toContain("Violet"); // default chip (parent-provided) untouched
    expect(html).not.toContain(">Teal<"); // English swatch name gone
  });
});
