// v4/03 §7 decision 8 — refereeOfficialsPlan acceptance (Task 8). PURE: every
// pack is hand-built, no DB. The referee runs a deterministic engine pass over
// (pack.locked + plan.assignments), turns declared-unfilled slots the solver can
// fill into lazy-unfilled warnings with a candidate, and adds the server-side
// "ineligible" supplement (wrong role, maxPerDay, blackout, busy-elsewhere,
// tampered lock) the engine skips for locked rows.
import { describe, expect, it } from "vitest";
import type { AiOfficialsPlan } from "../officials-ai-prompt";
import { refereeOfficialsPlan, type OfficialsPack } from "../officials-ai";

const POLICY = {
  roles: ["referee"],
  poolLock: false,
  blockStay: false,
  fairness: "tournament" as const,
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
};

function pack(over: Partial<OfficialsPack>): OfficialsPack {
  return {
    division: { id: "div", name: "Open", sport: "generic", tz: "UTC" },
    match_minutes: 30,
    policy: POLICY,
    fixtures: [],
    officials: [],
    locked: [],
    draft: [],
    instruction: "",
    prior: null,
    ...over,
  };
}

function fixture(
  id: string,
  start_at: string,
  entrants: string[] = [],
): OfficialsPack["fixtures"][number] {
  return { id, start_at, court: "Court 1", pool: null, entrants };
}

function official(
  id: string,
  over: Partial<OfficialsPack["officials"][number]> = {},
): OfficialsPack["officials"][number] {
  return {
    id,
    name: id,
    role_keys: ["referee"],
    home_pool_id: null,
    max_per_day: null,
    blackout_dates: [],
    busy_elsewhere: [],
    entrant_ids: [],
    ...over,
  };
}

function plan(over: Partial<AiOfficialsPlan>): AiOfficialsPlan {
  return { assignments: [], unfilled: [], explanations: [], summary: "", ...over };
}

describe("refereeOfficialsPlan (v4/03 §7 decision 8)", () => {
  it("flags an overlap the LLM created", () => {
    const p = pack({
      fixtures: [
        fixture("f1", "2026-08-01T09:00:00+00:00"),
        fixture("f2", "2026-08-01T09:15:00+00:00"), // overlaps f1's 09:00–09:30
      ],
      officials: [official("o1")],
    });
    const { conflicts } = refereeOfficialsPlan(
      p,
      plan({
        assignments: [
          { fixture_id: "f1", official_id: "o1", role_key: "referee" },
          { fixture_id: "f2", official_id: "o1", role_key: "referee" },
        ],
      }),
    );
    expect(conflicts.some((c) => c.kind === "official_overlap")).toBe(true);
  });

  it("flags wrong-role via ineligible", () => {
    const p = pack({
      fixtures: [fixture("f1", "2026-08-01T09:00:00+00:00")],
      officials: [official("o1", { role_keys: ["umpire"] })],
    });
    const { conflicts } = refereeOfficialsPlan(
      p,
      plan({ assignments: [{ fixture_id: "f1", official_id: "o1", role_key: "referee" }] }),
    );
    const bad = conflicts.find((c) => c.kind === "ineligible");
    expect(bad).toBeDefined();
    expect(bad).toMatchObject({ severity: "block", officialId: "o1", roleKey: "referee" });
  });

  it("flags maxPerDay breach via ineligible", () => {
    const p = pack({
      fixtures: [
        fixture("f1", "2026-08-01T09:00:00+00:00"),
        fixture("f2", "2026-08-01T11:00:00+00:00"), // same UTC day, no overlap
      ],
      officials: [official("o1", { max_per_day: 1 })],
    });
    const { conflicts } = refereeOfficialsPlan(
      p,
      plan({
        assignments: [
          { fixture_id: "f1", official_id: "o1", role_key: "referee" },
          { fixture_id: "f2", official_id: "o1", role_key: "referee" },
        ],
      }),
    );
    expect(conflicts.some((c) => c.kind === "ineligible" && /max/i.test(c.detail))).toBe(true);
  });

  it("flags a blackout-date assignment via ineligible", () => {
    const p = pack({
      fixtures: [fixture("f1", "2026-08-01T09:00:00+00:00")],
      officials: [official("o1", { blackout_dates: ["2026-08-01"] })],
    });
    const { conflicts } = refereeOfficialsPlan(
      p,
      plan({ assignments: [{ fixture_id: "f1", official_id: "o1", role_key: "referee" }] }),
    );
    expect(
      conflicts.some(
        (c) => c.kind === "ineligible" && c.officialId === "o1" && /blackout/i.test(c.detail),
      ),
    ).toBe(true);
  });

  it("lazy unfilled: declared-unfilled slot the solver can fill comes back with a candidate", () => {
    const p = pack({
      fixtures: [fixture("f1", "2026-08-01T09:00:00+00:00")],
      officials: [official("o1")],
    });
    const { conflicts, lazyUnfilled } = refereeOfficialsPlan(
      p,
      plan({ unfilled: [{ fixture_id: "f1", role_key: "referee", reason: "gave up" }] }),
    );
    expect(lazyUnfilled).toEqual([
      { fixture_id: "f1", role_key: "referee", candidate_official_id: "o1" },
    ]);
    expect(conflicts.some((c) => c.kind === "role_unfilled")).toBe(false);
  });

  it("does not offer a lazy candidate the engine can't see is on blackout", () => {
    const p = pack({
      fixtures: [fixture("f1", "2026-08-01T09:00:00+00:00")],
      officials: [official("o1", { blackout_dates: ["2026-08-01"] })],
    });
    const { lazyUnfilled } = refereeOfficialsPlan(
      p,
      plan({ unfilled: [{ fixture_id: "f1", role_key: "referee", reason: "gave up" }] }),
    );
    expect(lazyUnfilled).toEqual([]);
  });

  it("confirmed unfilled passes through as role_unfilled without a candidate", () => {
    const p = pack({
      fixtures: [fixture("f1", "2026-08-01T09:00:00+00:00")],
      officials: [official("o1", { role_keys: ["umpire"] })], // nobody can referee
    });
    const { conflicts, lazyUnfilled } = refereeOfficialsPlan(
      p,
      plan({ unfilled: [{ fixture_id: "f1", role_key: "referee", reason: "no referee free" }] }),
    );
    expect(lazyUnfilled).toEqual([]);
    const unfilled = conflicts.find((c) => c.kind === "role_unfilled");
    expect(unfilled).toMatchObject({ fixtureId: "f1", roleKey: "referee" });
    expect("candidate_official_id" in (unfilled as object)).toBe(false);
  });

  it("locked row altered → ineligible block", () => {
    const p = pack({
      fixtures: [fixture("f1", "2026-08-01T09:00:00+00:00")],
      officials: [official("o1"), official("o2")],
      locked: [{ fixtureId: "f1", officialId: "o1", roleKey: "referee", locked: true }],
    });
    const { conflicts } = refereeOfficialsPlan(
      p,
      plan({ assignments: [{ fixture_id: "f1", official_id: "o2", role_key: "referee" }] }),
    );
    expect(
      conflicts.some(
        (c) =>
          c.kind === "ineligible" && c.officialId === "o1" && /locked/i.test(c.detail),
      ),
    ).toBe(true);
  });
});
