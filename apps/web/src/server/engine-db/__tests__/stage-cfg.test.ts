// PROMPT-61 §2 — stage-scoped decider overlay, pure.
import { describe, expect, it } from "vitest";
import { stageScopedCfg } from "../stage-cfg";

describe("stageScopedCfg", () => {
  it("overlays only shootout/extraTime from the stage config", () => {
    const div = { shootout: false, points: { win: 3 }, halfMinutes: 45 };
    expect(
      stageScopedCfg(div, {
        shootout: true,
        extraTime: { enabled: true, halfMinutes: 15 },
        points: { win: 99 }, // stage points are competition.ts territory, not deciders
      }),
    ).toEqual({
      shootout: true,
      extraTime: { enabled: true, halfMinutes: 15 },
      points: { win: 3 },
      halfMinutes: 45,
    });
  });

  it("is the identity when the stage sets no decider key", () => {
    const div = { extraTime: { enabled: true, halfMinutes: 15 } };
    expect(stageScopedCfg(div, null)).toBe(div);
    expect(stageScopedCfg(div, undefined)).toBe(div);
    expect(stageScopedCfg(div, {})).toBe(div);
    expect(stageScopedCfg(div, { rngSeed: 7 })).toBe(div);
  });
});
