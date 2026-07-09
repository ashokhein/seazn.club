// Schema-level regression tests (no DB) for the entrant/team contract added
// with the unified Add-Entrant + team-squad work.
import { describe, expect, it } from "vitest";
import { CreateEntrant, CreateTeam, SetTeamSquad } from "../schemas";

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
