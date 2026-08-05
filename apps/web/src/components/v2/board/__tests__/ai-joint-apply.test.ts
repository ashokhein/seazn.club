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
  const anchors = [
    { divisionId: "d1", checkpointId: "cp-1" },
    { divisionId: "d2", checkpointId: "cp-2" },
  ];

  const RESTORE_URL = "/api/v1/competitions/c1/schedule/restore";

  /** The endpoint's success envelope, per division. */
  const restored = (ids: string[], failed: { division_id: string; reason: string }[] = []) => ({
    restored: ids.map((id, i) => ({ division_id: id, watermark: 3 + i, steps: 1 })),
    failed,
    ok: failed.length === 0,
  });

  /** Every refusal this client has to tell apart, as `v1()` serialises them.
   *  Both the 404 and the 422 carry no `code` — the usecase throws a bare
   *  `HttpError(status, message)` — so the STATUS is the only discriminator
   *  there, and keying on a code would silently match nothing. */
  const refuse = (status: number, code: string) => () => {
    throw new ApiV1Error("nope", status, code);
  };

  it("undoes a joint apply with ONE competition-scoped call, not N per-division calls (#386)", async () => {
    // THE regression assertion. The client used to loop the per-division
    // restore, so the apply was atomic while the undo was N independent writes
    // and a closed tab left the board half-restored. N calls here means the
    // loop came back.
    const { api, calls } = recorder({ [RESTORE_URL]: restored(["d1", "d2"]) });
    expect(await undoJointApply("c1", anchors, api)).toEqual({ ok: true, failed: [] });
    expect(calls.map((c) => c.url)).toEqual([RESTORE_URL]);
  });

  it("sends the anchors snake_cased, with the confirm the endpoint requires", async () => {
    // Every other test here mocks the api, so a camelCased body would pass all
    // of them and 422 in production against the real zod schema. The body is
    // the contract, not the path.
    const { api, calls } = recorder({ [RESTORE_URL]: restored(["d1", "d2"]) });
    await undoJointApply("c1", anchors, api);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].json).toEqual({
      checkpoints: [
        { division_id: "d1", checkpoint_id: "cp-1" },
        { division_id: "d2", checkpoint_id: "cp-2" },
      ],
      confirm: true,
    });
  });

  it("surfaces the server's per-division failures", async () => {
    // The ids are the point. Collapsed into a boolean, the console can only say
    // "some divisions", which sends the organiser to open every division page
    // to find out which.
    const { api } = recorder({
      [RESTORE_URL]: restored(["d1"], [{ division_id: "d2", reason: "checkpoint not found" }]),
    });
    expect(await undoJointApply("c1", anchors, api)).toEqual({ ok: false, failed: ["d2"] });
  });

  it("reports every division as unrestored when the call itself fails", async () => {
    // A network error, a 500 — nothing was restored and saying "some divisions
    // failed" would be a guess. No `refusal`: this is not a refusal the server
    // explained, it is a call that never landed.
    const { api } = recorder({
      [RESTORE_URL]: () => {
        throw new ApiV1Error("boom", 500, "SERVER_ERROR");
      },
    });
    expect(await undoJointApply("c1", anchors, api)).toEqual({ ok: false, failed: ["d1", "d2"] });
  });

  it("tells a restore ALREADY RUNNING apart from a failed one, and claims no failures", async () => {
    // The realistic cause is the same organiser submitting twice — a
    // double-clicked Undo or a second tab. This call did nothing, so naming
    // every division as unrestored would be a lie in the direction that
    // matters: the organiser would go and undo them by hand while the first
    // undo is still rewinding them.
    const { api } = recorder({ [RESTORE_URL]: refuse(409, "SCHEDULE_APPLY_RESTORE_IN_PROGRESS") });
    expect(await undoJointApply("c1", anchors, api)).toEqual({
      ok: false,
      failed: [],
      refusal: "retry",
    });
  });

  it("treats any other 409 as retryable too, rather than as a dead undo", async () => {
    // The retryable-lock code is the one the joint apply raises today; a 409
    // from this endpoint means a concurrent writer either way, and "wait and
    // try again" is the honest answer for all of them.
    const { api } = recorder({ [RESTORE_URL]: refuse(409, "SEQ_CONFLICT") });
    expect((await undoJointApply("c1", anchors, api)).refusal).toBe("retry");
  });

  it("tells a division set that no longer matches the apply apart from a failure", async () => {
    // 422 — the set must equal the apply event's `division_ids` EXACTLY, so
    // this means the competition has been applied again since. Retrying cannot
    // fix it; the organiser needs each division's own restore.
    const { api } = recorder({ [RESTORE_URL]: refuse(422, "UNPROCESSABLE") });
    expect(await undoJointApply("c1", anchors, api)).toEqual({
      ok: false,
      failed: [],
      refusal: "changed",
    });
  });

  it("tells 'nothing to undo' apart from a failure", async () => {
    // 404 — no joint apply on this competition at all.
    const { api } = recorder({ [RESTORE_URL]: refuse(404, "NOT_FOUND") });
    expect(await undoJointApply("c1", anchors, api)).toEqual({
      ok: false,
      failed: [],
      refusal: "gone",
    });
  });

  it("fires no request at all for an empty undo", async () => {
    // The endpoint would 422 it (`checkpoints` is `.min(1)`), and a refusal the
    // client can compute is a refusal it should not pay a round trip for.
    const { api, calls } = recorder();
    expect(await undoJointApply("c1", [], api)).toEqual({ ok: false, failed: [], refusal: "gone" });
    expect(calls).toEqual([]);
  });
});
