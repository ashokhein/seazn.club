import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeriodPad } from "@/components/v2/pads/period-pad";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import type { LiveState, SideInfo, SportInfo } from "@/components/v2/fixture-console";

// #355: countdown() used to read stampsRef (a ref) during render. The stamp
// state now lives in useState, so these pin the same visible behaviour the
// ref version had — full duration on arrival, ticking down, and a clean slot
// for whatever suspension comes next — without the render-reads-a-ref hazard.
const side = (id: string, name: string): SideInfo => ({ id, name, members: [], lineup: [] });

const sport: SportInfo = {
  key: "icehockey",
  config: { suspensions: { classes: { minor: { minutes: 2, teamShort: true } } } },
  scorerLabel: "Scorer",
  positionGroups: [],
  roles: [],
  lineupSize: 6,
  fidelityTiers: [
    {
      tier: 3,
      eventTypes: [
        "icehockey.goal",
        "icehockey.period.advance",
        "icehockey.suspension.start",
        "icehockey.suspension.end",
        "icehockey.shootout.attempt",
      ],
    },
  ],
};

function liveWith(suspensions: unknown[]): LiveState {
  return {
    status: "in_play",
    last_seq: 1,
    summary: { headline: "0 — 0" },
    state: { phase: "P1", goals: { home: 0, away: 0 }, suspensions },
    outcome: null,
  };
}

const noSuspensions = liveWith([]);
const home = side("h", "Harbor");
const away = side("a", "Summit");
const baseProps = { sport, home, away, send: async () => true, busy: false };

const hintText = (tree: ReturnType<typeof walk>) => {
  const hint = tree.find(
    (el) => el.type === "span" && String(propsOf(el).className ?? "").includes("text-amber-700"),
  );
  return hint ? textOf(hint) : null;
};

describe("PeriodPad countdown (#355 — no ref read during render)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the class's full duration the moment a suspension appears mid-match", () => {
    const island = renderIsland(PeriodPad, { ...baseProps, live: noSuspensions });
    expect(hintText(island.tree())).toBeNull();

    island.rerender({
      ...baseProps,
      live: liveWith([{ side: "home", classKey: "minor", teamShort: true, permanent: false }]),
    });
    expect(hintText(island.tree())).toBe("2:00");
  });

  it("ticks down once a second as the penalty runs", () => {
    const island = renderIsland(PeriodPad, {
      ...baseProps,
      live: liveWith([{ side: "home", classKey: "minor", teamShort: true, permanent: false }]),
    });
    expect(hintText(island.tree())).toBe("2:00");

    vi.advanceTimersByTime(5000);
    expect(hintText(island.tree())).toBe("1:55");

    vi.advanceTimersByTime(60000);
    expect(hintText(island.tree())).toBe("0:55");
  });

  it("cleans up the stamp when the suspension ends, so the next one starts fresh", () => {
    const island = renderIsland(PeriodPad, {
      ...baseProps,
      live: liveWith([{ side: "home", classKey: "minor", teamShort: true, permanent: false }]),
    });
    vi.advanceTimersByTime(10000);
    expect(hintText(island.tree())).toBe("1:50");

    // Released: the scorer's explicit action, not a timeout.
    island.rerender({ ...baseProps, live: noSuspensions });
    expect(hintText(island.tree())).toBeNull();

    vi.advanceTimersByTime(30000);
    island.rerender({
      ...baseProps,
      live: liveWith([{ side: "away", classKey: "minor", teamShort: true, permanent: false }]),
    });
    // A stale stamp from the first suspension would show < 2:00 here.
    expect(hintText(island.tree())).toBe("2:00");
  });

  it("stops ticking once no suspensions remain", () => {
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    const island = renderIsland(PeriodPad, {
      ...baseProps,
      live: liveWith([{ side: "home", classKey: "minor", teamShort: true, permanent: false }]),
    });
    island.rerender({ ...baseProps, live: noSuspensions });
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});
