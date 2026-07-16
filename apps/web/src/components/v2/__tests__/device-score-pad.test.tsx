import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DeviceScorePad } from "@/components/v2/device-score-pad";
import { SetbasedPad } from "@/components/v2/pads/setbased-pad";
import { DictProvider } from "@/components/i18n/dict-provider";
import frUi from "@/dictionaries/fr/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { LiveState, SportInfo, SideInfo } from "@/components/v2/fixture-console";

// Courtside-pad mobile fixes (user report, 12 Jul): set-score headlines used
// to wrap mid-number at phone widths, and the rally target read as a text
// link. These pin the render contract; interaction stays with e2e.

const sport: SportInfo = {
  key: "badminton",
  config: {},
  scorerLabel: "Umpire",
  positionGroups: [],
  roles: [],
  lineupSize: 2,
  fidelityTiers: [
    { tier: 3, eventTypes: ["badminton.rally"] },
    { tier: 0, eventTypes: ["badminton.game_summary"] },
  ] as SportInfo["fidelityTiers"],
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

const live: LiveState = {
  status: "in_play",
  last_seq: 7,
  summary: { headline: "1 — 0 · 21-18 (16-12)" },
  state: {
    phase: "set",
    sets: [
      { home: 21, away: 18, closed: true },
      { home: 16, away: 12, closed: false },
    ],
    setsWon: { home: 1, away: 0 },
    cfg: { bestOf: 3 },
  },
  outcome: null,
};

describe("device score pad on phones", () => {
  it("headline groups are atomic — wrap only between ' · ' groups, fluid size", () => {
    const html = renderToStaticMarkup(
      <DeviceScorePad
        token="dl_test"
        deviceLinkId="link-1"
        fixture={{
          id: "f1",
          round_no: 2,
          venue: null,
          court_label: "Court 2",
          competition_name: "Summer League",
          division_name: "Badminton Doubles",
        }}
        sport={sport}
        home={side("h", "Nia & Marco")}
        away={side("a", "Mira & Josh")}
        initialState={live}
        initialEvents={[]}
      />,
    );
    expect(html).toContain('<span class="inline-block whitespace-nowrap">1 — 0');
    expect(html).toContain('<span class="inline-block whitespace-nowrap">21-18 (16-12)</span>');
    // The old fixed-size headline ("text-5xl font-bold") died with the wrap
    // bug — fluid clamp instead. (Rally cards keep a plain text-5xl numeral.)
    expect(html).not.toContain("text-5xl font-bold");
    expect(html).toContain("clamp(1.5rem,8.5vw,3rem)");
  });

  it("rally card is one big touch target with a button-shaped '+ point'", () => {
    const html = renderToStaticMarkup(
      <SetbasedPad
        sport={sport}
        home={side("h", "Nia & Marco")}
        away={side("a", "Mira & Josh")}
        live={live}
        send={async () => true}
        busy={false}
      />,
    );
    expect(html).toContain("touch-manipulation");
    expect(html).toContain("bg-purple-600");
    expect(html).toContain("+ point");
  });

  // v5 i18n: score pads read chrome via useMsg(), so wrapping a pad in a
  // <DictProvider> for a non-English locale localizes its labels (sport
  // vocabulary stays canonical). Fails if a pad hardcodes an English string.
  it("localizes pad chrome under a DictProvider (fr)", () => {
    const html = renderToStaticMarkup(
      <DictProvider dict={frUi as unknown as Dict} locale="fr">
        <SetbasedPad
          sport={sport}
          home={side("h", "Nia & Marco")}
          away={side("a", "Mira & Josh")}
          live={live}
          send={async () => true}
          busy={false}
        />
      </DictProvider>,
    );
    expect(html).toContain("Échange par échange"); // pad.rallyByRally (fr)
    expect(html).not.toContain("Rally-by-rally"); // no English leak
  });
});
