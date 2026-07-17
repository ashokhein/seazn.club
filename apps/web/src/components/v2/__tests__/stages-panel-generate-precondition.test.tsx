import { describe, expect, it } from "vitest";
import { generatePreconditionMessage } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";

// Regression (design/fix-ui/03-console-division.md "Group-stage 'Générer les
// matchs' gives a misleading success message when it generates nothing"): a
// Groups+Knockout division with too few entrants (2, when the configured
// groups need more) showed a green "Rien de nouveau à générer — les matchs
// sont à jour" (up to date) success banner, even though zero fixtures had
// ever been generated — the phase card still read "no matches yet". The
// server now throws STAGE_NOT_READY / reason=group_too_few_entrants instead
// of returning the same { created: 0, existing: 0 } shape as a real no-op;
// this is the client-side classifier that turns that into an actionable,
// non-success message instead of falling through to the generic error text.
describe("generatePreconditionMessage — StagesPanel generate-click classifier", () => {
  it("returns an actionable message for a group stage that can't fill its groups yet", () => {
    const err = new ApiV1Error(
      "not enough entrants to fill 4 groups — each group needs at least 2 (have 2, need 8)",
      422,
      "STAGE_NOT_READY",
      { reason: "group_too_few_entrants", groups: 4, entrants: 2, required: 8 },
    );
    const text = generatePreconditionMessage(err, msg);
    expect(text).not.toBeNull();
    // Actionable — tells the organiser what to DO, not just that nothing
    // happened, and must not read as the "up to date" success copy.
    expect(text).toContain("4");
    expect(text).toContain("8");
    expect(text).toContain("2");
    expect(text).not.toBe(msg("schedule.notice.nothingNew"));
  });

  it("returns null for an unrelated ApiV1Error (falls through to the generic error banner)", () => {
    const err = new ApiV1Error("boom", 500, "INTERNAL", {});
    expect(generatePreconditionMessage(err, msg)).toBeNull();
  });

  it("returns null for a plain Error (not an ApiV1Error)", () => {
    expect(generatePreconditionMessage(new Error("network down"), msg)).toBeNull();
  });

  it("returns null for PAYMENT_REQUIRED so the paywall gate still wins", () => {
    const err = new ApiV1Error("upgrade", 402, "PAYMENT_REQUIRED", { feature_key: "formats.advanced" });
    expect(generatePreconditionMessage(err, msg)).toBeNull();
  });
});
