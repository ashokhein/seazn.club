// Body copy for the expensive-AI-run staff alert (v17 gap #295, folded review
// item from Task 2/3).
//
// The alert used to say only "a schedule AI run … cost $X". That is not enough
// to act on: the two things that decide whether an expensive run is a PRICING
// problem or just a big job are the run's MODE (a full regenerate is a
// different cost class from a nudge) and its SIZE (`pack_units`, stamped by
// Task 2/3). Without them a reader has to go open /admin/ai-runs to learn
// whether $0.90 was 3x normal or a 400-fixture pack behaving exactly as
// expected.
//
// Two properties the copy must NOT get wrong:
//
//  1. The unit means a different thing per phase. The schedule path stamps
//     `movableIds.size` (only the fixtures it was asked to move); the officials
//     path stamps `pack.fixtures.length` (every fixture in the pack). So the
//     noun is part of the number — "42 movable fixtures" vs "42 fixtures" — and
//     a per-unit figure is never comparable across the two.
//  2. `pack_units` is NULLABLE in practice — every event written before this
//     wave lacks the key, and the alert must render honestly (no size clause,
//     no "undefined", no divide-by-zero) rather than printing a fake 0.
//
// The median stays POOLED across modes on purpose (calibration data first —
// mode-scoped baselines are deferred), so the copy has to say so; otherwise
// "2x the median" reads as "2x the median FOR THIS MODE", which it is not.
//
// Internal staff alert: NOT localised (composed inline in lib/email.ts, takes
// no locale/Dict), so English is the only copy to assert. Asserted through the
// real send path with `fetch` stubbed — the body string is built inside the
// send function and there is no separate template export to call. Same shape as
// pass-credit-reversal-alert-email.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAiRunCostAlertEmail } from "../email";
import { AI_RUN_UNIT_NOUN, aiRunUnitNoun } from "../ai-pricing";

interface SentPayload {
  subject: string;
  html: string;
  text: string;
}

let sent: SentPayload[] = [];
const OLD_KEY = process.env.RESEND_API_KEY;

beforeEach(() => {
  sent = [];
  process.env.RESEND_API_KEY = "re_test_key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as SentPayload);
      return { ok: true, status: 200, text: async () => "" } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (OLD_KEY === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = OLD_KEY;
});

const base = {
  to: "ops@seazn.test",
  orgId: "org-123",
  competitionId: "comp-456",
  model: "claude-sonnet-5",
  costUsd: 0.5,
  medianUsd: 0.05,
  windowDays: 30,
};

describe("aiRunUnitNoun (pure, v17 gap #295)", () => {
  it("names a different unit per phase — the two paths stamp different denominators", () => {
    // schedule stamps movableIds.size (the movable SUBSET), officials stamps
    // pack.fixtures.length (ALL fixtures). Same key, different meaning: a
    // blended cross-phase $/unit would be arithmetic on two different things.
    expect(AI_RUN_UNIT_NOUN.schedule).toBe("movable fixture");
    expect(AI_RUN_UNIT_NOUN.officials).toBe("fixture");
    expect(AI_RUN_UNIT_NOUN.schedule).not.toBe(AI_RUN_UNIT_NOUN.officials);
  });

  it("pluralises on the count (1 -> singular, everything else -> plural)", () => {
    expect(aiRunUnitNoun("schedule", 1)).toBe("movable fixture");
    expect(aiRunUnitNoun("schedule", 42)).toBe("movable fixtures");
    expect(aiRunUnitNoun("officials", 1)).toBe("fixture");
    expect(aiRunUnitNoun("officials", 0)).toBe("fixtures");
    expect(aiRunUnitNoun("officials")).toBe("fixtures");
  });
});

describe("sendAiRunCostAlertEmail — mode + pack_units in the copy (v17 gap #295)", () => {
  it("names the run mode and the pack size, and labels the schedule unit as MOVABLE fixtures", async () => {
    await sendAiRunCostAlertEmail({
      ...base,
      phase: "schedule",
      mode: "regenerate",
      packUnits: 40,
    });

    expect(sent).toHaveLength(1);
    const { subject, text, html } = sent[0]!;
    // Mode — a regenerate and a nudge are different cost classes.
    expect(text).toContain("mode: regenerate");
    expect(html).toContain("regenerate");
    // Size, with the schedule-specific noun.
    expect(text).toContain("40 movable fixtures");
    // $/unit at the run's own size: $0.50 / 40 = $0.0125.
    expect(text).toContain("$0.0125 per movable fixture");
    // The baseline is pooled — the copy must not let "10.0x the median" be
    // read as "10x the median for THIS mode".
    expect(text).toContain("pooled across every mode");
    // No placeholder leakage, and the subject is unchanged in shape.
    expect(subject).toContain("Expensive AI run");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("labels the officials unit as plain fixtures and flags that roster size is not stamped", async () => {
    await sendAiRunCostAlertEmail({
      ...base,
      phase: "officials",
      packUnits: 8,
    });

    expect(sent).toHaveLength(1);
    const { text } = sent[0]!;
    expect(text).toContain("8 fixtures");
    // The schedule wording must NOT leak onto an officials run.
    expect(text).not.toContain("movable");
    // Officials cost also scales with roster size, which is deliberately not
    // stamped — a reader comparing $/fixture across officials runs needs to
    // know the denominator is incomplete.
    expect(text.toLowerCase()).toContain("roster size");
    // officials runs carry no mode, so no empty "(mode: )" fragment.
    expect(text).not.toContain("mode:");
  });

  it("renders honestly when pack_units is absent (pre-wave rows) — no size clause, no fake zero", async () => {
    await sendAiRunCostAlertEmail({ ...base, phase: "schedule" });

    expect(sent).toHaveLength(1);
    const { text, html } = sent[0]!;
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("NaN");
    // No invented size, and no "0 movable fixtures" (which would read as a
    // real, empty pack rather than a missing measurement).
    expect(text).not.toContain("movable fixtures");
    expect(text).not.toContain("per movable fixture");
    // The panel says so explicitly rather than omitting the row silently.
    expect(text).toContain("$0.5000");
    expect(html).toContain("not recorded");
  });

  it("does not divide by zero when a run stamped zero units", async () => {
    await sendAiRunCostAlertEmail({ ...base, phase: "schedule", packUnits: 0 });

    expect(sent).toHaveLength(1);
    const { text } = sent[0]!;
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("NaN");
    // Zero units IS a real measurement (a pack with nothing movable), so it is
    // reported — only the per-unit ratio is suppressed.
    expect(text).toContain("0 movable fixtures");
    expect(text).not.toContain("per movable fixture");
  });
});
