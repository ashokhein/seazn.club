import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CricketPad } from "@/components/v2/pads/cricket-pad";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";

// #467 — the DLS revised target had no surface at all. The engine resolves the
// live chase target to `revisedTarget` whenever it is non-null, so a pad that
// never reads it shows a score against a target the app does not state. #451
// was a real DLS defect that awarded a match to the WRONG SIDE, and it survived
// because this value was invisible: an unrendered derivation is an unverified
// one. Sentinel strings prove the copy comes from the dictionary rather than
// being hardcoded English in the component.
const dict: Dict = {
  ...(uiEn as unknown as Dict),
  "pad.ck.targetDls": "«dls-loc {runs}»",
  "pad.ck.targetManual": "«manual-loc {runs}»",
};

const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });
const sport = { config: { ballsPerOver: 6, inningsPerSide: 1 } } as unknown as SportInfo;

const live = (state: Record<string, unknown>): LiveState => ({
  status: "live",
  last_seq: 12,
  summary: {},
  outcome: null,
  state: {
    phase: "live",
    tossTaken: true,
    entrants: { home: "h", away: "a" },
    innings: [
      {
        battingSide: "home",
        runs: 120,
        wickets: 4,
        legalBalls: 90,
        closed: true,
        fine: null,
      },
      {
        battingSide: "away",
        runs: 44,
        wickets: 1,
        legalBalls: 36,
        closed: false,
        fine: { striker: null, nonStriker: null, currentBowler: null, dismissed: [] },
      },
    ],
    ...state,
  },
});

const render = (state: Record<string, unknown>): string =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      <CricketPad
        sport={sport}
        home={side("h", "Harbor CC")}
        away={side("a", "Summit CC")}
        live={live(state)}
        send={async () => true}
        busy={false}
      />
    </DictProvider>,
  );

describe("cricket pad renders the revised target (#467)", () => {
  it("shows a DLS-revised target, localized, with its run figure", () => {
    const html = render({ revisedTarget: 178, targetSource: "dls" });
    expect(html).toContain("«dls-loc 178»");
    expect(html).toContain('data-testid="ck-revised-target"');
  });

  it("distinguishes a MANUALLY set target from a DLS-derived one", () => {
    // Not cosmetic: a DLS figure is the app's own arithmetic and a manual one is
    // the organiser's. Showing a bare number would conflate them.
    const html = render({ revisedTarget: 150, targetSource: "manual" });
    expect(html).toContain("«manual-loc 150»");
    expect(html).not.toContain("«dls-loc");
  });

  it("renders NOTHING target-ish when the target has not been revised", () => {
    // The guard that makes the two assertions above meaningful — a pad that
    // always rendered a target row would satisfy them both.
    const html = render({ revisedTarget: null, targetSource: null });
    expect(html).not.toContain('data-testid="ck-revised-target"');
    expect(html).not.toContain("«dls-loc");
    expect(html).not.toContain("«manual-loc");
  });
});
