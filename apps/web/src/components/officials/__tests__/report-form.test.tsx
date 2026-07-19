import { describe, expect, it } from "vitest";
import { partitionDrafts } from "../report-form";
import uiEn from "@/dictionaries/en/ui.json";

// This workspace runs vitest with environment: "node" (no jsdom / testing-
// library — see run-your-own-cta.test.tsx). The save/submit data-loss gate is
// exercised through its pure decision fn `partitionDrafts`, which save() and
// submit() consult BEFORE any PUT: an `incompleteCount > 0` blocks the write and
// shows the inline `report.incidentNoteRequired` error instead of silently
// dropping the incident (a lost red_card would skip the report→suspension bridge).
describe("report-form incident note gate (data-loss regression)", () => {
  it("(a) blocks save/submit when an incident has a kind or player but a blank note", () => {
    // red_card + player picked, note left blank → must be flagged, never dropped.
    const redCardNoNote = partitionDrafts([{ kind: "red_card", person_id: "p1", note: "  " }]);
    expect(redCardNoNote.incompleteCount).toBe(1);
    expect(redCardNoNote.incidents).toHaveLength(0);

    // A player chosen on the default kind, still no note → also incomplete.
    expect(partitionDrafts([{ kind: "other", person_id: "p1", note: "" }]).incompleteCount).toBe(1);
    // A non-default kind alone (no player), no note → incomplete.
    expect(partitionDrafts([{ kind: "misconduct", person_id: "", note: "" }]).incompleteCount).toBe(1);

    // The inline error the gate surfaces must be real copy.
    expect((uiEn as Record<string, string>)["report.incidentNoteRequired"]).toBeTruthy();
  });

  it("(b) still prunes a completely empty row silently (default kind, no player, no note)", () => {
    const res = partitionDrafts([{ kind: "other", person_id: "", note: "" }]);
    expect(res.incompleteCount).toBe(0);
    expect(res.incidents).toHaveLength(0);
  });

  it("(c) a note on the default kind with no person is kept as an 'other' incident — not pruned, not incomplete", () => {
    const res = partitionDrafts([{ kind: "other", person_id: "", note: "pitch was waterlogged" }]);
    expect(res.incompleteCount).toBe(0);
    expect(res.incidents).toEqual([{ kind: "other", note: "pitch was waterlogged" }]);
  });

  it("keeps a valid incident (note present), trims it, and prunes empties alongside it", () => {
    const res = partitionDrafts([
      { kind: "red_card", person_id: "p1", note: "  violent conduct 88'  " },
      { kind: "other", person_id: "", note: "" }, // empty → pruned silently
    ]);
    expect(res.incompleteCount).toBe(0);
    expect(res.incidents).toEqual([{ kind: "red_card", note: "violent conduct 88'", person_id: "p1" }]);
  });
});
