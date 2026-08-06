// Schema-level regression tests (no DB) for the entrant/team contract added
// with the unified Add-Entrant + team-squad work.
import { describe, expect, it } from "vitest";
import {
  CreateClubContact,
  CreateCompetition,
  CreateDivision,
  CreateEntrant,
  CreateStage,
  CreateTeam,
  PatchCompetition,
  PatchEntrant,
  SetTeamSquad,
} from "../schemas";

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

describe("CreateClubContact", () => {
  it("accepts a valid contact with a well-formed email", () => {
    expect(
      CreateClubContact.safeParse({ role_key: "secretary", full_name: "X", email: "sec@club.test" })
        .success,
    ).toBe(true);
  });

  it("rejects a malformed email at the edge (400, not a DB round-trip)", () => {
    const r = CreateClubContact.safeParse({
      role_key: "secretary",
      full_name: "X",
      email: "not-an-email",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "email")).toBe(true);
    }
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

describe("CreateEntrant.members — inline new persons (PROMPT-60 §2)", () => {
  it("accepts a mix of person_id and new_person members", () => {
    const r = CreateEntrant.safeParse({
      kind: "team",
      display_name: "Mexico",
      members: [
        { person_id: UUID, squad_number: 1 },
        { new_person: { full_name: "Striker Nine" }, squad_number: 9 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a member with neither person_id nor new_person, and >40 members", () => {
    expect(
      CreateEntrant.safeParse({
        kind: "team", display_name: "X", members: [{ squad_number: 1 }],
      }).success,
    ).toBe(false);
    expect(
      CreateEntrant.safeParse({
        kind: "team", display_name: "X",
        members: Array.from({ length: 41 }, (_, i) => ({ new_person: { full_name: `P${i}` } })),
      }).success,
    ).toBe(false);
  });

  it("accepts badge_url on create and PATCH (nullable to clear)", () => {
    expect(
      CreateEntrant.safeParse({
        kind: "individual", display_name: "Solo", badge_url: "https://flags.example/x.png",
      }).success,
    ).toBe(true);
    expect(PatchEntrant.safeParse({ badge_url: null }).success).toBe(true);
    expect(PatchEntrant.safeParse({ badge_url: "entrant-badges/a.png" }).success).toBe(true);
  });
});

// #376: a competition with no end date can never reach the `past_ends_on`
// pass lock, and holds a `competitions.max_active` slot forever. The date is
// therefore mandatory at create, and — the half that actually closes the
// evasion — non-removable at edit: an org must not be able to PATCH it back
// to null and drop out of the lock again.
describe("competition end date is mandatory and non-removable (#376)", () => {
  const base = { name: "Summer Cup", starts_on: "2026-06-01" };
  const issuePaths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
    r.success ? [] : (r.error?.issues ?? []).map((i) => i.path.join("."));

  it("rejects a create with no ends_on at all", () => {
    const r = CreateCompetition.safeParse({ ...base });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toContain("ends_on");
  });

  it("rejects a create that sends ends_on: null", () => {
    const r = CreateCompetition.safeParse({ ...base, ends_on: null });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toContain("ends_on");
  });

  it("accepts a create with a well-formed ends_on", () => {
    const r = CreateCompetition.safeParse({ ...base, ends_on: "2026-08-31" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ends_on).toBe("2026-08-31");
  });

  it("rejects a PATCH that clears ends_on to null", () => {
    const r = PatchCompetition.safeParse({ ends_on: null });
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toContain("ends_on");
  });

  it("still accepts a PATCH that CHANGES ends_on to another date", () => {
    const r = PatchCompetition.safeParse({ ends_on: "2027-01-15" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.ends_on).toBe("2027-01-15");
  });

  it("still accepts a PATCH that omits ends_on entirely (the field stays optional to send)", () => {
    expect(PatchCompetition.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  it("still accepts a PATCH that clears starts_on — only the END date is protected", () => {
    expect(PatchCompetition.safeParse({ starts_on: null }).success).toBe(true);
  });
});

describe("competition ends_on >= starts_on (#376)", () => {
  it("rejects a create whose end date precedes its start date", () => {
    const r = CreateCompetition.safeParse({
      name: "Backwards", starts_on: "2026-06-01", ends_on: "2026-05-31",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "ends_on");
      expect(issue?.message).toBe("The end date cannot be before the start date.");
    }
  });

  it("accepts a single-day competition (ends_on === starts_on)", () => {
    expect(
      CreateCompetition.safeParse({ name: "One Day", starts_on: "2026-06-01", ends_on: "2026-06-01" })
        .success,
    ).toBe(true);
  });

  it("accepts a create with no starts_on — there is nothing to compare against", () => {
    expect(CreateCompetition.safeParse({ name: "Open Ended", ends_on: "2026-06-01" }).success).toBe(
      true,
    );
  });

  it("rejects a PATCH that moves ends_on before the starts_on in the SAME patch", () => {
    const r = PatchCompetition.safeParse({ starts_on: "2026-06-01", ends_on: "2026-05-31" });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join(".") === "ends_on")).toBe(true);
    }
  });

  it("accepts a PATCH carrying only one of the two dates", () => {
    expect(PatchCompetition.safeParse({ ends_on: "2020-01-01" }).success).toBe(true);
    expect(PatchCompetition.safeParse({ starts_on: "2030-01-01" }).success).toBe(true);
  });
});

describe("division tiebreakers are validated keys (F5)", () => {
  it("accepts the expanded fifa2026 cascade, rejects the preset NAME", () => {
    const good = ["points", "h2h_points", "h2h_diff", "h2h_for", "diff", "for", "fair_play", "lots"];
    expect(
      CreateDivision.safeParse({
        name: "Open", sport_key: "football", variant_key: "std", tiebreakers: good,
      }).success,
    ).toBe(true);
    expect(
      CreateDivision.safeParse({
        name: "Open", sport_key: "football", variant_key: "std", tiebreakers: ["fifa2026"],
      }).success,
    ).toBe(false); // silent seed-order standings, never again
  });
});
