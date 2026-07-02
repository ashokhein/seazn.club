// EngineError taxonomy — spec 03 §7. Typed codes, never bare strings; the API
// layer maps codes → HTTP (409/422/402) centrally and surfaces messages
// verbatim in the UI.
import { z } from "zod";

// spec 03 §7
export const EngineErrorCode = z.enum([
  "INVALID_EVENT",
  "WRONG_PHASE",
  "ALREADY_DECIDED",
  "LINEUP_INVALID",
  "CONFIG_INVALID",
  "SEQ_CONFLICT",
  "STAGE_NOT_READY",
  "ELIGIBILITY",
]);
export type EngineErrorCode = z.infer<typeof EngineErrorCode>;

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly data?: unknown;

  constructor(code: EngineErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.data = data;
  }

  is(code: EngineErrorCode): boolean {
    return this.code === code;
  }

  static is(err: unknown, code?: EngineErrorCode): err is EngineError {
    return err instanceof EngineError && (code === undefined || err.code === code);
  }
}
