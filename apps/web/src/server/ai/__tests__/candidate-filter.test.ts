import { describe, it, expect } from "vitest";
import { eligibleCandidates, MIN_CONTEXT_TOKENS } from "../candidate-filter";

const model = (over: Partial<Parameters<typeof eligibleCandidates>[0][number]> = {}) => ({
  id: "vendor/model",
  context_length: 200_000,
  supported_parameters: ["reasoning", "response_format", "structured_outputs"],
  ...over,
});

describe("candidate filter", () => {
  it("keeps a model supporting reasoning + structured outputs with enough context", () => {
    expect(eligibleCandidates([model()]).map((c) => c.id)).toEqual(["vendor/model"]);
  });

  it("drops a model that cannot reason — no-thinking left blocking conflicts in the v4 bench", () => {
    const out = eligibleCandidates([
      model({ id: "vendor/no-reason", supported_parameters: ["structured_outputs"] }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops a model without structured outputs — the runners read a parsed plan", () => {
    const out = eligibleCandidates([
      model({ id: "vendor/no-schema", supported_parameters: ["reasoning"] }),
    ]);
    expect(out).toEqual([]);
  });

  it("drops a model whose context is below the floor", () => {
    const out = eligibleCandidates([
      model({ id: "vendor/small", context_length: MIN_CONTEXT_TOKENS - 1 }),
    ]);
    expect(out).toEqual([]);
  });

  it("is stable and de-duplicated regardless of input order", () => {
    const a = model({ id: "a/one" });
    const b = model({ id: "b/two" });
    expect(eligibleCandidates([b, a, b]).map((c) => c.id)).toEqual(["a/one", "b/two"]);
  });
});
