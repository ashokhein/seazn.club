import { describe, expect, it } from "vitest";
import { buildGrid, gridStepMinutes, MAX_SLOTS } from "./build-grid.ts";
import type { Assignment, SlotConfig } from "./calendar.ts";

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 8, 8, 0); // Sat 08 Aug 2026, 08:00Z

const cfg = (over: Partial<SlotConfig> = {}): SlotConfig & { courts: string[] } => ({
  startAt: T0,
  matchMinutes: 30,
  gapMinutes: 10,
  courts: ["C1", "C2"],
  perEntrantMinRest: 0,
  window: { from: T0, to: T0 + 4 * 60 * MIN },
  ...over,
});

describe("gridStepMinutes", () => {
  it("is the gcd of match and gap length", () => {
    expect(gridStepMinutes({ matchMinutes: 60, gapMinutes: 15 })).toBe(15);
    expect(gridStepMinutes({ matchMinutes: 45, gapMinutes: 10 })).toBe(5);
  });

  it("degenerates to the match length when there is no gap", () => {
    expect(gridStepMinutes({ matchMinutes: 45, gapMinutes: 0 })).toBe(45);
  });

  it("never goes below the repair grid", () => {
    expect(gridStepMinutes({ matchMinutes: 7, gapMinutes: 3 })).toBe(5);
  });
});

describe("buildGrid", () => {
  it("covers every court across the window at the step", () => {
    const g = buildGrid({ config: cfg() });
    expect(g.stepMinutes).toBe(10);
    // A 30-minute match must FIT: last legal start is window.to - 30 min.
    const c1 = g.byCourt.get("C1")!;
    expect(g.slots[c1[0]!]!.startAt).toBe(T0);
    expect(g.slots[c1[c1.length - 1]!]!.startAt).toBe(T0 + (4 * 60 - 30) * MIN);
    expect(g.byCourt.get("C2")!.length).toBe(c1.length);
    expect(g.overCap).toBe(false);
  });

  it("drops starts whose occupancy overlaps a global blackout", () => {
    const g = buildGrid({ config: cfg({ blackouts: [{ from: T0 + 60 * MIN, to: T0 + 90 * MIN }] }) });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts).not.toContain(T0 + 60 * MIN);
    expect(starts).not.toContain(T0 + 40 * MIN); // 40..70 overlaps
    expect(starts).toContain(T0 + 30 * MIN); // 30..60 touches, does not overlap
    expect(starts).toContain(T0 + 90 * MIN);
  });

  it("scopes a court-scoped blackout to that court only", () => {
    const g = buildGrid({ config: cfg({ blackouts: [{ court: "C1", from: T0, to: T0 + 60 * MIN }] }) });
    expect(g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt)).not.toContain(T0);
    expect(g.byCourt.get("C2")!.map((i) => g.slots[i]!.startAt)).toContain(T0);
  });

  it("admits only starts fully inside a session window", () => {
    const g = buildGrid({
      config: cfg({ sessionWindows: [{ from: T0 + 60 * MIN, to: T0 + 150 * MIN }] }),
    });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts[0]).toBe(T0 + 60 * MIN);
    expect(starts[starts.length - 1]).toBe(T0 + 120 * MIN); // 120..150 fits
  });

  it("removes court-time an existing booking occupies, including the gap", () => {
    const existing: Assignment[] = [{
      fixtureId: "x", court: "C1",
      startAt: T0 + 60 * MIN, endAt: T0 + 90 * MIN,
      entrants: [], people: [],
    }];
    const g = buildGrid({ config: cfg(), existing });
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts).not.toContain(T0 + 60 * MIN);
    expect(starts).not.toContain(T0 + 50 * MIN); // needs the 10-minute gap
    expect(starts).toContain(T0 + 100 * MIN); // 90 + 10 gap
    expect(g.byCourt.get("C2")!.map((i) => g.slots[i]!.startAt)).toContain(T0 + 60 * MIN);
  });

  it("admits an off-grid pinned start so a locked card stays representable", () => {
    const pinnedAt = T0 + 7 * MIN; // not a multiple of the 10-minute step
    const g = buildGrid({ config: cfg(), pinned: [{ court: "C1", startAt: pinnedAt }] });
    expect(g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt)).toContain(pinnedAt);
  });

  it("keeps a start whose match runs past midnight into the next day", () => {
    // step = gcd(90, 30) = 30, so a start can sit 30 minutes short of midnight
    // and legally run past it. A day bucket must gate which starts BELONG to it
    // — that is what makes the DST anchoring below correct — but it must not
    // bound the occupancy, or this slot is deleted from the lattice outright:
    // the next bucket cannot recover it, because that bucket opens AT midnight.
    //
    // Needs `stepMinutes < matchMinutes` to show up at all, i.e. any non-zero
    // gap. Every other test here either stays inside one day or sets
    // matchMinutes === gapMinutes, where gcd(a, a) = a makes step === duration
    // and the bug cannot manifest.
    const from = Date.UTC(2026, 7, 8, 0, 0);
    const g = buildGrid({
      config: cfg({ tz: "UTC", window: { from, to: from + 3 * DAY }, matchMinutes: 90, gapMinutes: 30 }),
    });
    expect(g.stepMinutes).toBe(30);
    const starts = g.byCourt.get("C1")!.map((i) => g.slots[i]!.startAt);
    expect(starts).toContain(from + 1380 * MIN); // 23:00 day 0, ends 00:30 day 1
    expect(starts).toContain(from + 1410 * MIN); // 23:30 day 0, ends 01:00 day 1
    expect(starts).toContain(from + DAY + 1380 * MIN); // and again across day 1 -> day 2
    // The universe end is still the real bound: nothing may run past it, so the
    // final day's 23:00 start is correctly absent.
    for (const s of g.slots) expect(s.startAt + 90 * MIN).toBeLessThanOrEqual(from + 3 * DAY);
    expect(starts).not.toContain(from + 2 * DAY + 1380 * MIN);
  });

  it("anchors each day at local midnight so a DST day does not drift", () => {
    // Europe/London springs forward 29 Mar 2026 at 01:00 local, making that a
    // 23-hour day.
    //
    // The step MUST NOT divide that 23-hour day, or this test proves nothing.
    // Every Europe/London local midnight falls on a whole UTC hour, so with a
    // 60-minute step the day-anchored lattice and a lattice stepped straight
    // through in UTC are the SAME SET — no assertion can tell them apart. At 45
    // minutes they diverge: local midnight on 30 Mar is 2820 minutes after the
    // window start, which is not a multiple of 45, so UTC stepping opens that
    // day at 00:15 local instead of 00:00.
    const from = Date.UTC(2026, 2, 28, 0, 0);
    const g = buildGrid({
      config: cfg({ tz: "Europe/London", window: { from, to: from + 4 * DAY }, matchMinutes: 45, gapMinutes: 45 }),
    });
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });
    const local = (ms: number) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
    };
    // `slots` is sorted by (court, startAt), so the first start seen for a local
    // day is that day's earliest.
    const firstByDay = new Map<string, string>();
    for (const s of g.slots) {
      const { day, time } = local(s.startAt);
      if (!firstByDay.has(day)) firstByDay.set(day, time);
    }
    // Spans the transition with days either side of it, so the assertion below
    // is not satisfied by an empty or single-day lattice.
    expect([...firstByDay.keys()]).toEqual(["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31", "2026-04-01"]);
    // Every local day opens at local midnight, on BOTH sides of the transition.
    expect([...firstByDay.values()]).toEqual(["00:00", "00:00", "00:00", "00:00", "00:00"]);
  });

  it("flags overCap and returns no slots when the lattice is too large", () => {
    const g = buildGrid({
      config: cfg({ window: { from: T0, to: T0 + 400 * DAY }, courts: ["C1", "C2", "C3", "C4"] }),
    });
    expect(g.overCap).toBe(true);
    expect(g.slots.length).toBe(0);
  });

  it("is deterministic", () => {
    expect(buildGrid({ config: cfg() })).toEqual(buildGrid({ config: cfg() }));
  });

  it("exposes the cap", () => {
    expect(MAX_SLOTS).toBe(20_000);
  });
});
