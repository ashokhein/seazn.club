// core.award rendering: the canonical engine payload is { person, key }
// (Jul3/07 §4) — the feed showed "Awarded to Unknown" for every MOTM because
// the renderer read a `to` field that only legacy rows carry.
import { describe, expect, it } from "vitest";
import { describeEvent } from "../event-copy";

const NAMES = { p1: "Ashokkumar K S", e1: "Lions U12" };

describe("describeEvent core.award", () => {
  it("renders MOTM from the canonical { person, key } payload", () => {
    const d = describeEvent("core.award", { person: "p1", key: "motm" }, NAMES);
    expect(d.label).toBe("MOTM");
    expect(d.text).toBe("Man of the match — Ashokkumar K S");
    expect(d.tone).toBe("admin");
  });

  it("prettifies other award keys", () => {
    const d = describeEvent("core.award", { person: "p1", key: "player_of_series" }, NAMES);
    expect(d.label).toBe("Award");
    expect(d.text).toBe("Player of series — Ashokkumar K S");
  });

  it("keeps the legacy { to } fallback working", () => {
    const d = describeEvent("core.award", { to: "e1" }, NAMES);
    expect(d.text).toContain("Lions U12");
  });

  it("degrades to Unknown only when the id is truly absent from the map", () => {
    const d = describeEvent("core.award", { person: "ghost", key: "motm" }, NAMES);
    expect(d.text).toBe("Man of the match — Unknown");
  });
});
