import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DivisionBuilder, buildScheduleSeed } from "@/components/v2/division-builder";
import { msg } from "@/lib/messages";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

// Regression: the creation wizard's Scheduling step seeds schedule-settings
// right after create. Two ways that seed used to be lost silently —
//   1. the fallback venue was the hardcoded "Court 1", not the sport's noun;
//   2. a >1 venue list trips usesConstraints() server-side, which 402s the
//      WHOLE settings PUT for a Community org — so match length, start and end
//      date were discarded too, with the wizard's `catch {}` hiding it.
// The wizard now gates the venue list behind the Pro feature AND retries the
// seed with a single venue if the first PUT fails.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));

const SPORTS = [
  { key: "football", name: "Football", variants: [{ key: "standard", name: "Standard", system: true }] },
];

function render(constraintsAllowed: boolean): string {
  return renderToStaticMarkup(
    <DictProvider dict={uiEn as unknown as Dict} locale="en">
      <DivisionBuilder
        competitionId="c1"
        orgSlug="org"
        compSlug="comp"
        sports={SPORTS}
        constraintsAllowed={constraintsAllowed}
      />
    </DictProvider>,
  );
}

describe("buildScheduleSeed — wizard schedule-settings seed", () => {
  const input = {
    courts: ["Pitch 1", "  Pitch 2  ", "  "],
    matchMinutes: 90,
    startAt: "2026-08-01T10:00",
    endAt: "2026-08-03",
    venueCap: "Pitch",
  };

  it("trims the venue list and converts the local inputs to ISO", () => {
    const seed = buildScheduleSeed(input);
    expect(seed.courts).toEqual(["Pitch 1", "Pitch 2"]);
    expect(seed.matchMinutes).toBe(90);
    expect(seed.startAt).toBe(new Date("2026-08-01T10:00").toISOString());
    expect(seed.endAt).toBe(new Date("2026-08-03T23:59:00").toISOString());
  });

  it("falls back to the SPORT's venue noun, not a hardcoded Court 1", () => {
    expect(buildScheduleSeed({ ...input, courts: ["", "   "] }).courts).toEqual(["Pitch 1"]);
  });

  it("singleVenue keeps dates + match length while dropping the extra venues", () => {
    // The retry after a 402: everything the organiser typed survives except
    // the part the plan actually gates.
    const seed = buildScheduleSeed(input, { singleVenue: true });
    expect(seed.courts).toEqual(["Pitch 1"]);
    expect(seed.matchMinutes).toBe(90);
    expect(seed.startAt).not.toBeNull();
    expect(seed.endAt).not.toBeNull();
  });

  it("leaves unset dates null (a blank scheduling step is still valid)", () => {
    const seed = buildScheduleSeed({ ...input, startAt: "", endAt: "" });
    expect(seed.startAt).toBeNull();
    expect(seed.endAt).toBeNull();
  });
});

describe("DivisionBuilder — venue list gate", () => {
  it("offers Add venue when the org has scheduling.constraints", () => {
    const html = render(true);
    expect(html).toContain(msg("boardset.addVenue", { venue: "pitch" }));
    expect(html).not.toContain(msg("wizard.venuesProHint", { venue: "pitch" }));
  });

  it("replaces Add venue with the Pro hint + upgrade gate without the feature", () => {
    const html = render(false);
    expect(html).not.toContain(msg("boardset.addVenue", { venue: "pitch" }));
    expect(html).toContain(msg("wizard.venuesProHint", { venue: "pitch" }));
    // The same paywall component the schedule settings panel uses.
    expect(html).toContain("/settings/billing");
  });
});
