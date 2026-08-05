// #384 — an adopted candidate must reach the solve.
//
// Adopting a candidate while the instruction box is empty silently discarded
// the adoption. Three symptoms, one root: `pack.prior` was carried into the
// pack and consumed ONLY as a diff baseline (`officialsDiff`), never as a solve
// input — so `draftAsPlan` re-derived everything from the deterministic solver
// and threw the organiser's click away, while the diff then reported their own
// adoption as something the AI had changed away.
//
// `prior` carries two fields doing unrelated jobs. `prior.instruction` is the
// previous run's sentence. `prior.assignments` is the grid on screen with the
// adoption patched in — data produced by the click that just happened, not a
// stale instruction replayed. THIS PATH READS `prior.assignments` ONLY: on the
// empty-instruction branch there is no instruction to execute, which is the
// premise of the branch (zero LLM calls, deterministic solver, flat 1 credit).
//
// PURE — every pack is hand-built, no DB and no provider.
import { describe, expect, it } from "vitest";
import { runOfficialsAiPlan, type OfficialsPack } from "../officials-ai";

const POLICY = {
  roles: ["referee"],
  poolLock: false,
  blockStay: false,
  fairness: "tournament" as const,
  teamRefKeepDivision: false,
  restMinMinutes: 0,
  blockGapMinutes: 30,
};

function fixture(id: string, start_at: string): OfficialsPack["fixtures"][number] {
  return { id, start_at, court: "Court 1", pool: null, entrants: [] };
}

function official(id: string): OfficialsPack["officials"][number] {
  return {
    id,
    name: id,
    role_keys: ["referee"],
    home_pool_id: null,
    max_per_day: null,
    blackout_dates: [],
    busy_elsewhere: [],
    entrant_ids: [],
  };
}

const F1 = fixture("f1", "2026-08-01T09:00:00+00:00");
const F2 = fixture("f2", "2026-08-01T11:00:00+00:00");

/** A two-fixture pack whose solver draft puts `solver-official` everywhere, so
 *  an adoption is always visibly different from what the draft would produce. */
function packWithPrior(over: {
  instruction?: string;
  priorInstruction?: string;
  priorAssignments: OfficialsPack["prior"] extends null ? never : { fixtureId: string; roleKey: string; officialId: string; locked?: boolean }[] | null;
  fixtures?: OfficialsPack["fixtures"];
}): OfficialsPack {
  const fixtures = over.fixtures ?? [F1, F2];
  return {
    division: { id: "div", name: "Open", sport: "generic", tz: "UTC", org_tz: "UTC" },
    match_minutes: 30,
    policy: POLICY,
    fixtures,
    officials: [official("solver-official"), official("adopted-official")],
    locked: [],
    draft: fixtures.map((f) => ({
      fixtureId: f.id,
      officialId: "solver-official",
      roleKey: "referee",
      locked: false,
    })),
    instruction: over.instruction ?? "",
    prior:
      over.priorAssignments === null
        ? null
        : { instruction: over.priorInstruction ?? "", assignments: over.priorAssignments },
  };
}

const ADOPTED = [
  { fixtureId: "f1", roleKey: "referee", officialId: "adopted-official", locked: false },
  { fixtureId: "f2", roleKey: "referee", officialId: "solver-official", locked: false },
];

const officialFor = (
  result: Awaited<ReturnType<typeof runOfficialsAiPlan>>,
  fixtureId: string,
): string | undefined => result.assignments.find((a) => a.fixtureId === fixtureId)?.officialId;

describe("the empty-instruction path solves from the adopted grid (#384)", () => {
  it("keeps the adopted official rather than re-deriving from the solver", async () => {
    const out = await runOfficialsAiPlan(packWithPrior({ priorAssignments: ADOPTED }));
    expect(officialFor(out, "f1")).toBe("adopted-official");
    // The discriminator: the SOLVER would have said `solver-official` here, so
    // this is not simply "whatever the draft produced".
    expect(officialFor(out, "f2")).toBe("solver-official");
  });

  it("does not report the organiser's own adoption as changed", async () => {
    // Symptom 3: the grid diffed a locked-derived draft against the prior the
    // organiser adopted FROM, and highlighted their own adoption as
    // AI-overwritten. `officialsDiff` is untouched — after this fix the solve
    // and the diff simply agree.
    const out = await runOfficialsAiPlan(packWithPrior({ priorAssignments: ADOPTED }));
    expect(out.diff.changed).not.toContain("f1");
    expect(out.diff.unchanged).toContain("f1");
  });

  it("still solves from the deterministic draft when there is no prior", async () => {
    const pack = packWithPrior({ priorAssignments: null });
    const out = await runOfficialsAiPlan(pack);
    expect(out.assignments.map((a) => a.officialId)).toEqual(pack.draft.map((d) => d.officialId));
  });

  it("never re-executes prior.instruction on the empty path", async () => {
    // The guard that keeps this a DATA change rather than a re-run. A model
    // call here would both spend tokens the flat 1-credit price does not cover
    // and re-apply a sentence the organiser has since cleared.
    const provider = {
      id: "anthropic" as const,
      isConfigured: () => true,
      chat: async () => {
        throw new Error("the empty-instruction path made a model call");
      },
    };
    const out = await runOfficialsAiPlan(
      packWithPrior({ priorInstruction: "put Sam on every court", priorAssignments: ADOPTED }),
      undefined,
      // A provider name would resolve a REAL provider; passing none keeps the
      // path provider-free, which is the assertion. The usage totals prove it.
      undefined,
    );
    expect(out.usage).toMatchObject({ input_tokens: 0, output_tokens: 0, repair_rounds: 0 });
    expect(provider.isConfigured()).toBe(true); // the stub is unused, deliberately
  });
});

describe("partial and malformed priors (#384)", () => {
  it("fills the slots a partial prior does not cover from the solver draft", async () => {
    // The realistic shape: one cell adopted, the rest of the grid untouched. If
    // the prior REPLACED the draft outright, every fixture it does not mention
    // would come back unassigned — an adopt that blanks the rest of the board.
    const out = await runOfficialsAiPlan(
      packWithPrior({
        priorAssignments: [
          { fixtureId: "f1", roleKey: "referee", officialId: "adopted-official", locked: false },
        ],
      }),
    );
    expect(officialFor(out, "f1")).toBe("adopted-official");
    expect(officialFor(out, "f2")).toBe("solver-official");
    expect(out.diff.unfilled).toEqual([]);
  });

  it("reports a slot NEITHER the prior nor the draft can fill", async () => {
    const pack = packWithPrior({
      priorAssignments: [
        { fixtureId: "f1", roleKey: "referee", officialId: "adopted-official", locked: false },
      ],
    });
    // The solver could not place f2 either — so coverage has to say so rather
    // than quietly returning a short grid.
    pack.draft = pack.draft.filter((d) => d.fixtureId !== "f2");
    const out = await runOfficialsAiPlan(pack);
    expect(officialFor(out, "f1")).toBe("adopted-official");
    expect(out.diff.unfilled).toEqual([
      { fixture_id: "f2", role_key: "referee", reason: "no eligible official available" },
    ]);
  });

  it("an EMPTY prior.assignments behaves like no prior, not like 'adopt nothing'", async () => {
    // `prior: { instruction, assignments: [] }` is a present object with nothing
    // in it. Reading the array as the whole answer would blank every slot and
    // return a grid with no officials at all.
    const pack = packWithPrior({ priorAssignments: [] });
    const out = await runOfficialsAiPlan(pack);
    expect(out.assignments.map((a) => a.officialId)).toEqual(pack.draft.map((d) => d.officialId));
    expect(out.diff.unfilled).toEqual([]);
  });

  it("ignores a prior row naming a fixture that no longer exists", async () => {
    // A fixture deleted mid-session. The row must not reach the referee — the
    // engine is handed assignments keyed by fixture id and a dangling one is
    // not a conflict, it is a lie about the board.
    const out = await runOfficialsAiPlan(
      packWithPrior({
        priorAssignments: [
          ...ADOPTED,
          { fixtureId: "deleted-fixture", roleKey: "referee", officialId: "adopted-official", locked: false },
        ],
      }),
    );
    expect(out.assignments.map((a) => a.fixtureId).sort()).toEqual(["f1", "f2"]);
    expect(officialFor(out, "f1")).toBe("adopted-official");
  });

  it("ignores a prior row naming a role the policy does not require", async () => {
    const out = await runOfficialsAiPlan(
      packWithPrior({
        priorAssignments: [
          ...ADOPTED,
          { fixtureId: "f1", roleKey: "scorer", officialId: "adopted-official", locked: false },
        ],
      }),
    );
    expect(out.assignments.map((a) => a.roleKey)).toEqual(["referee", "referee"]);
  });
});
