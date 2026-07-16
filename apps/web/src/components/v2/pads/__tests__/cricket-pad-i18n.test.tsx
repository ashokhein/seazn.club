import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BallForm } from "@/components/v2/pads/cricket-pad";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { SideInfo } from "@/components/v2/fixture-console";

// The wicket/extra <option> labels must read the wicket.*/extra.* keys from the
// active dictionary, not the raw payload enum. Sentinel values prove the wiring
// localizes independently of whether fr/es/nl are translated yet.
const dict: Dict = {
  ...(uiEn as unknown as Dict),
  "wicket.runout": "«runout-loc»",
  "extra.wide": "«wide-loc»",
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });
const innings = {
  battingSide: "home" as const,
  runs: 0,
  wickets: 0,
  legalBalls: 0,
  closed: false,
  fine: { striker: null, nonStriker: null, currentBowler: null, dismissed: [] },
};

describe("cricket pad wicket/extra kind i18n", () => {
  it("localizes wicket + extra option labels from the dictionary", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={dict} locale="fr">
        <BallForm
          innings={innings}
          batting={side("h", "Harbor CC")}
          fielding={side("a", "Summit CC")}
          bpo={6}
          send={async () => true}
          busy={false}
        />
      </DictProvider>,
    );
    expect(html).toContain("«runout-loc»");
    expect(html).toContain("«wide-loc»");
    // No raw payload enum leaking into the option text.
    expect(html).not.toContain(">Run out<");
    expect(html).not.toContain("W: runout");
  });
});
