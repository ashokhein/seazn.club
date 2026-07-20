// V305 — the division Settings tab no longer asks for a timezone. The zone is
// an organisation setting and is inherited; asking per division was a question
// organisers could not answer consistently and the answers drifted.
//
// Pins the render contract in all four locales so a translated label cannot
// smuggle the field back in.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StandaloneScheduleSettings } from "@/components/v2/board/settings-panel";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { BoardConfig } from "@/components/v2/board/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const config: BoardConfig = {
  startAt: "2026-08-01T09:00:00.000Z",
  endAt: null,
  matchMinutes: 30,
  gapMinutes: 0,
  courts: ["Court 1"],
  perEntrantMinRest: 0,
  blackouts: [],
  sessionWindows: [],
};

const DICTS: [Locale, Dict, RegExp][] = [
  ["en", enUi as Dict, /Timezone/i],
  ["es", esUi as Dict, /Zona horaria/i],
  ["fr", frUi as Dict, /Fuseau horaire/i],
  ["nl", nlUi as Dict, /Tijdzone/i],
];

function render(locale: Locale, dict: Dict): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <StandaloneScheduleSettings
        divisionId="d1"
        config={config}
        canEdit
        constraintsAllowed
        venueCap="Court"
      />
    </DictProvider>,
  );
}

describe("division schedule settings — no timezone field", () => {
  for (const [locale, dict, label] of DICTS) {
    it(`renders no timezone control (${locale})`, () => {
      const html = render(locale, dict);
      // The panel itself still renders (guards against a vacuous pass).
      expect(html).toContain("input");
      expect(html).not.toMatch(label);
    });
  }

  it("has no dictionary key for a division timezone left behind", () => {
    for (const [, dict] of DICTS) {
      expect(dict["boardset.timezone"]).toBeUndefined();
      expect(dict["boardset.timezoneHint"]).toBeUndefined();
    }
  });
});
