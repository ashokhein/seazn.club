// #402 — the public registration body's self-declaration rules (no DB).
//
// The schema is the door, not the guarantee: `submitRegistration` refuses to
// link an undated, under-age or guardian-attended registrant no matter what
// arrives, and `materialise` resolves at most one roster entry however many are
// flagged. What the schema owes is the useful ERROR — a registrant who ticked
// "I'm registering myself" is told a date of birth is needed, rather than
// silently getting no link. Every clause below was previously untested.
import { describe, expect, it } from "vitest";
import { PublicRegisterRequest } from "../schemas";

const UUID = "11111111-1111-4111-8111-111111111111";
const ADULT_DOB = "1990-05-05";

/** A complete, valid anonymous body; each case overrides only what it tests. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    division_id: UUID,
    display_name: "Sam Player",
    contact_email: "sam@example.com",
    privacy_consent: true,
    ...over,
  };
}

/** The dotted path of every issue, so a rejection is attributed and not just
 *  counted — a body can be refused for the wrong reason and still "fail". */
function issuePaths(input: Record<string, unknown>): string[] {
  const r = PublicRegisterRequest.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

describe("PublicRegisterRequest — the self-declaration (#402)", () => {
  it("accepts a plain anonymous body with neither field", () => {
    const r = PublicRegisterRequest.safeParse(body());
    expect(r.success).toBe(true);
  });

  it("accepts one `self` entry with the affirmation and an adult dob", () => {
    const r = PublicRegisterRequest.safeParse(
      body({
        registering_self: true,
        dob: ADULT_DOB,
        players: [{ name: "Cap Tain", self: true }, { name: "Team Mate" }],
      }),
    );
    expect(r.success).toBe(true);
  });

  it("rejects TWO `self` entries — one registrant, one row", () => {
    expect(
      issuePaths(
        body({
          registering_self: true,
          dob: ADULT_DOB,
          players: [
            { name: "Cap Tain", self: true },
            { name: "Imposter Two", self: true },
          ],
        }),
      ),
    ).toContain("players");
  });

  it("rejects `self` without the affirmation that authorises the link", () => {
    expect(
      issuePaths(body({ dob: ADULT_DOB, players: [{ name: "Cap Tain", self: true }] })),
    ).toContain("players");
  });

  it("rejects the affirmation without a dob — undated, so possibly a child", () => {
    expect(issuePaths(body({ registering_self: true }))).toContain("dob");
    expect(issuePaths(body({ registering_self: true, dob: null }))).toContain("dob");
  });

  it("the affirmation with a dob is fine on its own (no roster involved)", () => {
    expect(PublicRegisterRequest.safeParse(body({ registering_self: true, dob: ADULT_DOB })).success)
      .toBe(true);
  });
});
