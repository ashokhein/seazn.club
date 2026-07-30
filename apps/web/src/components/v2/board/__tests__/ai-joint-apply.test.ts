// The JOINT accept (#350 Task 8). The plan endpoint charges credits; this is
// the step that turns the paid-for plan into a board, and the two things it
// must never get wrong are both invisible in a render:
//
//   1. THE UNDO ANCHOR. The per-stage chain (ai-apply.ts) creates a checkpoint
//      before it writes, which is where the applied state's one-tap Undo
//      restores to. The joint apply does not go through that chain, so without
//      this module a joint apply leaves the organiser no restore point at all —
//      a several-division board overwritten with no way back.
//   2. WHAT THE PAYLOAD CARRIES. A fixture set aside stays at its OLD slot,
//      where it is still a court obstacle; a division left with nothing after
//      that filtering must drop out entirely, because the request schema is
//      `assignments.min(1)` per division and a 400 here reads as a bug.
//
// The api seam is injected so call ORDER and payloads are assertable without a
// server, exactly as ai-apply.test.ts does it.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import {
  applyJointPlan,
  undoJointApply,
  type JointApplyInput,
  type JointApplyApi,
} from "../ai-joint-apply";

const AUDIT = {
  instruction: "Keep the two age groups off each other's courts.",
  summary: "Placed 4 fixtures across 2 divisions.",
  model: "claude-sonnet-5",
  repair_rounds: 1,
};

const slot = (id: string, hour: number, court: string) => ({
  fixture_id: id,
  scheduled_at: `2026-08-01T${String(hour).padStart(2, "0")}:00:00.000Z`,
  court_label: court,
});

/** Two divisions with DIFFERENT seqs and different fixture counts, so a payload
 *  that reuses one division's token for both, or collapses the two lists, is
 *  visible rather than coincidentally right. */
const input = (over: Partial<JointApplyInput> = {}): JointApplyInput => ({
  competitionId: "c1",
  divisions: [
    { divisionId: "d1", expectedSeq: 4, assignments: [slot("f1", 9, "Court 1"), slot("f2", 10, "Court 1")] },
    { divisionId: "d2", expectedSeq: 11, assignments: [slot("f3", 9, "Court 2")] },
  ],
  audit: AUDIT,
  excludedFixtureIds: [],
  checkpointLabel: "Before AI · test",
  ...over,
});

/** Records every call, and answers each url from a table. */
function recorder(answers: Record<string, unknown | (() => never)> = {}) {
  const calls: { url: string; method: string; json: unknown }[] = [];
  let n = 0;
  const api: JointApplyApi = async <T,>(url: string, options?: { method?: string; json?: unknown }) => {
    calls.push({ url, method: options?.method ?? "GET", json: options?.json });
    const answer = answers[url];
    if (typeof answer === "function") (answer as () => never)();
    if (answer !== undefined) return answer as T;
    n += 1;
    return { id: `cp-${n}`, applied: 3, conflicts: [] } as T;
  };
  return { api, calls };
}

const APPLY_URL = "/api/v1/competitions/c1/schedule/apply";
const cpUrl = (d: string) => `/api/v1/divisions/${d}/checkpoints`;

describe("applyJointPlan — the anchor comes first", () => {
  it("creates one undo anchor per division BEFORE anything is written", async () => {
    const { api, calls } = recorder();
    const out = await applyJointPlan(input(), api);

    // Order is the assertion. A checkpoint created after the write anchors the
    // wrong board; a checkpoint for only the first division leaves the rest
    // unrecoverable. There is no competition-scoped restore, so the anchor is
    // per division and every written division needs one.
    expect(calls.map((c) => c.url)).toEqual([cpUrl("d1"), cpUrl("d2"), APPLY_URL]);
    expect(calls[0].json).toEqual({ label: "Before AI · test", kind: "ai" });
    // kind:"ai" is not decoration — those anchors are exempt from the save-point
    // quota (V303), so a Community org can apply without first deleting one.
    expect(calls[1].json).toEqual({ label: "Before AI · test", kind: "ai" });
    expect(out.checkpoints).toEqual([
      { divisionId: "d1", checkpointId: "cp-1" },
      { divisionId: "d2", checkpointId: "cp-2" },
    ]);
    expect(out.status).toBe("applied");
  });

  it("writes nothing when an anchor cannot be created", async () => {
    const { api, calls } = recorder({
      [cpUrl("d2")]: () => {
        throw new ApiV1Error("nope", 402, "PAYMENT_REQUIRED", { feature_key: "schedule.checkpoints.max" });
      },
    });
    const out = await applyJointPlan(input(), api);

    expect(calls.map((c) => c.url)).toEqual([cpUrl("d1"), cpUrl("d2")]);
    expect(out.status).toBe("error");
    // The feature key, not the generic 402 code — the console renders the
    // save-point line from it rather than "upgrade to use AI".
    expect(out.errorCode).toBe("schedule.checkpoints.max");
    expect(out.errorStatus).toBe(402);
  });

  it("sends each division its own seq and its own assignments in one request", async () => {
    const { api, calls } = recorder();
    await applyJointPlan(input(), api);
    expect(calls[2].json).toEqual({
      divisions: [
        { division_id: "d1", expected_seq: 4, assignments: [slot("f1", 9, "Court 1"), slot("f2", 10, "Court 1")] },
        { division_id: "d2", expected_seq: 11, assignments: [slot("f3", 9, "Court 2")] },
      ],
      source: "ai",
      ai: AUDIT,
    });
  });
});

describe("applyJointPlan — fixtures set aside", () => {
  it("drops a set-aside fixture from its division's payload", async () => {
    const { api, calls } = recorder();
    await applyJointPlan(input({ excludedFixtureIds: ["f2"] }), api);
    const body = calls[2].json as { divisions: { division_id: string; assignments: unknown[] }[] };
    expect(body.divisions.map((d) => d.division_id)).toEqual(["d1", "d2"]);
    expect(body.divisions[0].assignments).toEqual([slot("f1", 9, "Court 1")]);
  });

  it("drops a division left with nothing, and its anchor with it", async () => {
    // `assignments` is `.min(1)` per division on the wire, so an emptied
    // division would 400 the whole apply. It also needs no anchor: nothing is
    // written there, so there is nothing to restore.
    const { api, calls } = recorder();
    const out = await applyJointPlan(input({ excludedFixtureIds: ["f3"] }), api);
    expect(calls.map((c) => c.url)).toEqual([cpUrl("d1"), APPLY_URL]);
    const body = calls[1].json as { divisions: { division_id: string }[] };
    expect(body.divisions.map((d) => d.division_id)).toEqual(["d1"]);
    expect(out.checkpoints).toEqual([{ divisionId: "d1", checkpointId: "cp-1" }]);
  });

  it("refuses to call anything when every fixture was set aside", async () => {
    const { api, calls } = recorder();
    const out = await applyJointPlan(input({ excludedFixtureIds: ["f1", "f2", "f3"] }), api);
    expect(calls).toEqual([]);
    expect(out.status).toBe("error");
    expect(out.errorCode).toBe("NO_ASSIGNMENTS");
  });
});

describe("applyJointPlan — how a refusal comes back", () => {
  it("tells a stale board apart from every other 409", async () => {
    // Only SEQ_CONFLICT is recoverable by re-running as a refine; a court clash
    // is not, and offering that button for it would send the organiser round a
    // loop that cannot end.
    const { api } = recorder({
      [APPLY_URL]: () => {
        throw new ApiV1Error("stale", 409, "SEQ_CONFLICT", { current_seq: 7 });
      },
    });
    expect((await applyJointPlan(input(), api)).status).toBe("seq_conflict");
  });

  it("carries the blocking conflicts out of a 409 instead of a bare status", async () => {
    // The 409 is the ONLY place the organiser can learn which fixtures clash —
    // the apply verifies the MERGED board, so these can name a clash that did
    // not exist at plan time.
    const conflicts = [{ fixtureId: "f2", reason: "court", detail: "Court 1 at 10:00" }];
    const { api } = recorder({
      [APPLY_URL]: () => {
        throw new ApiV1Error("clash", 409, "SCHEDULE_CONFLICT", { conflicts });
      },
    });
    const out = await applyJointPlan(input(), api);
    expect(out.status).toBe("conflict");
    expect(out.conflicts).toEqual(conflicts);
    // The anchors still exist — nothing was written, but the organiser has
    // them, and the console needs them to know the apply got that far.
    expect(out.checkpoints).toHaveLength(2);
  });

  it("reports how many placements landed on success", async () => {
    const { api } = recorder({ [APPLY_URL]: { applied: 3, conflicts: [] } });
    const out = await applyJointPlan(input(), api);
    expect(out).toMatchObject({ status: "applied", applied: 3, conflicts: [] });
  });
});

describe("undoJointApply", () => {
  it("restores every anchor the apply created", async () => {
    const { api, calls } = recorder();
    const ok = await undoJointApply(
      [
        { divisionId: "d1", checkpointId: "cp-1" },
        { divisionId: "d2", checkpointId: "cp-2" },
      ],
      api,
    );
    expect(ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/v1/divisions/d1/restore",
      "/api/v1/divisions/d2/restore",
    ]);
    expect(calls[0].json).toEqual({ checkpoint_id: "cp-1", confirm: true });
    expect(calls[1].json).toEqual({ checkpoint_id: "cp-2", confirm: true });
  });

  it("keeps restoring the rest when one division refuses, and says it was partial", async () => {
    // Restore is per division and there is no competition-scoped one, so a
    // failure part-way cannot be rolled back — stopping would leave MORE
    // divisions on the AI board than carrying on does.
    const { api, calls } = recorder({
      "/api/v1/divisions/d1/restore": () => {
        throw new ApiV1Error("locked", 422, "SCHEDULE_LOCKED");
      },
    });
    const ok = await undoJointApply(
      [
        { divisionId: "d1", checkpointId: "cp-1" },
        { divisionId: "d2", checkpointId: "cp-2" },
      ],
      api,
    );
    expect(ok).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/v1/divisions/d1/restore",
      "/api/v1/divisions/d2/restore",
    ]);
  });
});
