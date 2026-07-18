// Schema-level regression tests (no DB) for the entrant/team contract added
// with the unified Add-Entrant + team-squad work.
import { describe, expect, it } from "vitest";
import { CreateEntrant, CreateStage, CreateTeam, SetTeamSquad } from "../schemas";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("CreateEntrant", () => {
  it("accepts display_name without team_id", () => {
    expect(CreateEntrant.safeParse({ kind: "individual", display_name: "A" }).success).toBe(true);
  });

  it("accepts team_id without display_name (server snapshots the name)", () => {
    expect(CreateEntrant.safeParse({ kind: "team", team_id: UUID }).success).toBe(true);
  });

  it("rejects when BOTH display_name and team_id are absent", () => {
    const r = CreateEntrant.safeParse({ kind: "individual" });
    expect(r.success).toBe(false);
  });

  it("accepts an optional copy_roster_from_entrant_id", () => {
    const r = CreateEntrant.safeParse({ kind: "team", team_id: UUID, copy_roster_from_entrant_id: UUID });
    expect(r.success).toBe(true);
  });
});

describe("CreateTeam", () => {
  it("requires a name", () => {
    expect(CreateTeam.safeParse({ name: "Riverside U12" }).success).toBe(true);
    expect(CreateTeam.safeParse({ name: "" }).success).toBe(false);
    expect(CreateTeam.safeParse({}).success).toBe(false);
  });
});

describe("SetTeamSquad", () => {
  it("defaults members to an empty array", () => {
    const r = SetTeamSquad.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.members).toEqual([]);
  });

  it("accepts squad members in the entrant-member shape", () => {
    const r = SetTeamSquad.safeParse({
      members: [{ person_id: UUID, squad_number: 7, is_captain: true, roles: ["captain"] }],
    });
    expect(r.success).toBe(true);
  });
});

describe("CreateStage.qualification (PROMPT-59 §4 — typed spec at the edge)", () => {
  const stage = (qualification: unknown) => ({ seq: 2, kind: "knockout", name: "KO", qualification });

  it("accepts each of the four qualification shapes", () => {
    expect(CreateStage.safeParse(stage({ take: [{ pool: "A", rank: 1 }] })).success).toBe(true);
    expect(CreateStage.safeParse(stage({ topN: 4 })).success).toBe(true);
    expect(
      CreateStage.safeParse(stage({ bestOfRank: { rank: 3, count: 8, normaliseUnequalPools: true } }))
        .success,
    ).toBe(true);
    expect(
      CreateStage.safeParse(
        stage({
          combine: [
            { take: [{ pool: "A", rank: 1 }, { pool: "B", rank: 1 }] },
            { bestOfRank: { rank: 3, count: 2 } },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a nested combine and null/absent qualification", () => {
    expect(
      CreateStage.safeParse(
        stage({ combine: [{ topN: 2 }, { combine: [{ topN: 1 }, { topN: 1 }] }] }),
      ).success,
    ).toBe(true);
    expect(CreateStage.safeParse(stage(null)).success).toBe(true);
    expect(CreateStage.safeParse({ seq: 1, kind: "league", name: "L" }).success).toBe(true);
  });

  it("rejects malformed specs at the edge (400, not deep engine throw)", () => {
    expect(CreateStage.safeParse(stage({ bogus: 1 })).success).toBe(false);
    expect(CreateStage.safeParse(stage({ take: [{ pool: "A" }] })).success).toBe(false); // missing rank
    expect(CreateStage.safeParse(stage({ topN: 0 })).success).toBe(false);
    expect(CreateStage.safeParse(stage({ combine: [{ topN: 2 }] })).success).toBe(false); // min 2 children
  });
});
