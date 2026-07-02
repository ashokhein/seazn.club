// EngineError taxonomy — spec 03 §7.
import { describe, expect, it } from "vitest";
import { EngineError, EngineErrorCode } from "./errors.ts";

describe("EngineError", () => {
  it("carries a typed code, message and optional data", () => {
    const error = new EngineError("SEQ_CONFLICT", "expected seq 4, got 2", { expected: 4 });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EngineError");
    expect(error.code).toBe("SEQ_CONFLICT");
    expect(error.message).toBe("expected seq 4, got 2");
    expect(error.data).toEqual({ expected: 4 });
  });

  it(".is(code) matches the instance code", () => {
    const error = new EngineError("WRONG_PHASE", "not live");
    expect(error.is("WRONG_PHASE")).toBe(true);
    expect(error.is("INVALID_EVENT")).toBe(false);
  });

  it("static is() narrows unknown errors, optionally by code", () => {
    const error: unknown = new EngineError("ELIGIBILITY", "too old for U16");
    expect(EngineError.is(error)).toBe(true);
    expect(EngineError.is(error, "ELIGIBILITY")).toBe(true);
    expect(EngineError.is(error, "CONFIG_INVALID")).toBe(false);
    expect(EngineError.is(new Error("plain"))).toBe(false);
    expect(EngineError.is("nope")).toBe(false);
  });

  it("code taxonomy matches spec 03 §7", () => {
    expect(EngineErrorCode.options).toEqual([
      "INVALID_EVENT",
      "WRONG_PHASE",
      "ALREADY_DECIDED",
      "LINEUP_INVALID",
      "CONFIG_INVALID",
      "SEQ_CONFLICT",
      "STAGE_NOT_READY",
      "ELIGIBILITY",
    ]);
  });
});
