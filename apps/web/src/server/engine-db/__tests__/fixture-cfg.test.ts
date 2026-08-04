// W4a follow-up Task 1 — the single decision "which cfg does this fixture fold
// against". Pure, DB-free: the read fold and the write fold both route through
// it, so if this is right neither surface can drift back to live config on its
// own. The DB-backed proof that they actually do is in
// `config-snapshot.test.ts`.
import { describe, expect, it } from "vitest";
import { resolveFixtureCfg } from "../fixture-cfg";

const DIVISION = { bestOf: 3, points: { w: 3, d: 1, l: 0 }, shootout: null } as const;
const STAGE = { shootout: { bestOf: 5 }, placements: { "1": [1, 2] } };

describe("resolveFixtureCfg", () => {
  it("falls back to the live stage-scoped cfg when no snapshot has been taken", () => {
    // A fixture with zero events has nothing to protect: the organiser is still
    // setting the division up and the format they pick must apply.
    expect(resolveFixtureCfg(null, DIVISION, STAGE)).toEqual({
      ...DIVISION,
      shootout: { bestOf: 5 },
    });
  });

  it("applies the stage decider overlay on the fallback path, not the raw division config", () => {
    expect((resolveFixtureCfg(null, DIVISION, STAGE) as { shootout: unknown }).shootout).toEqual({
      bestOf: 5,
    });
  });

  it("leaves a division config untouched when the stage overlays nothing", () => {
    expect(resolveFixtureCfg(null, DIVISION, null)).toBe(DIVISION);
    expect(resolveFixtureCfg(undefined, DIVISION, undefined)).toBe(DIVISION);
  });

  it("returns the snapshot verbatim, ignoring both live configs entirely", () => {
    // THE POINT OF THE WHOLE TASK. The division has since been rewritten and the
    // stage now overlays a different shootout; a scored fixture must not notice.
    const snapshot = { bestOf: 3, points: { w: 3, d: 1, l: 0 }, shootout: { bestOf: 5 } };
    const movedDivision = { bestOf: 1, points: { w: 2, d: 0, l: 0 } };
    const movedStage = { shootout: { bestOf: 9 } };
    expect(resolveFixtureCfg(snapshot, movedDivision, movedStage)).toBe(snapshot);
  });

  it("keeps a snapshot that is falsy-but-present", () => {
    // `{}` is a legitimate config (several modules take one) and is falsy under
    // no JS operator, but a `snapshot || live` implementation would still be
    // wrong for `0`/`""`; assert on presence, not truthiness.
    const empty = {};
    expect(resolveFixtureCfg(empty, DIVISION, STAGE)).toBe(empty);
  });

  it("gives append-event the RESOLVED value to freeze — stage overlay applied", () => {
    // What the write path persists is exactly what this fallback returns, so
    // "resolved" has one definition rather than two that can diverge. Freezing
    // the RAW division config instead would leave `stageScopedCfg` to re-apply
    // at read time against a stage config that has since moved — the same drift
    // one layer down. The DB-backed proof that append-event really persists
    // THIS value is in `config-snapshot.test.ts`.
    expect(resolveFixtureCfg(null, DIVISION, STAGE)).not.toEqual(DIVISION);
  });
});
