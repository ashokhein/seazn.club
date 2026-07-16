import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StartWizard } from "../start-wizard";
import { DictProvider } from "../i18n/dict-provider";
import enMarketing from "@/dictionaries/en/marketing.json";
import frMarketing from "@/dictionaries/fr/marketing.json";
import type { Dict } from "@/lib/i18n-constants";

const en = enMarketing as unknown as Dict;
const fr = frMarketing as unknown as Dict;

function render(dict: Dict, locale: "en" | "fr") {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <StartWizard initial={{ sport: "Badminton", entrants: 16 }} />
    </DictProvider>,
  );
}

describe("StartWizard i18n", () => {
  it("renders step 1 copy from the English dict", () => {
    const html = render(en, "en");
    expect(html).toContain("Competition name");
    expect(html).toContain("Players or teams");
    expect(html).toContain("Recommend a format");
  });

  it("localizes the wizard from the dict (French)", () => {
    const html = render(fr, "fr");
    expect(html).toContain("Nom de la compétition");
    expect(html).toContain("Joueurs ou équipes");
    expect(html).toContain("Recommander un format");
    expect(html).not.toContain("Competition name");
  });
});
