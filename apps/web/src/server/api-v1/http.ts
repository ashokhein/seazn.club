import "server-only";
// /api/v1 HTTP kernel (doc 08 §1) — the handler() pattern of src/lib/http.ts,
// extended for the versioned API: every response carries the
// { ok, data | error, requestId } envelope, EngineError codes map to HTTP in
// exactly one place, and list endpoints share opaque base64 cursor pagination.
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import * as Sentry from "@sentry/nextjs";
import { EngineError, type EngineErrorCode } from "@seazn/engine/core";
import { AuthError, HttpError, PaymentRequiredError } from "@/lib/errors";

// EngineError.code → HTTP status (doc 08 §1, spec 03 §7). Central map — the
// only place engine codes meet HTTP. SEQ_CONFLICT is the optimistic-concurrency
// signal (409); everything the engine rejects as semantically invalid is 422.
const ENGINE_HTTP: Record<EngineErrorCode, number> = {
  SEQ_CONFLICT: 409,
  INVALID_EVENT: 422,
  WRONG_PHASE: 422,
  ALREADY_DECIDED: 422,
  LINEUP_INVALID: 422,
  CONFIG_INVALID: 422,
  STAGE_NOT_READY: 422,
  ELIGIBILITY: 422,
  MODULE_NOT_FOUND: 422,
  MODULE_DUPLICATE: 500,
};

// HTTP status → stable machine code for non-engine errors.
function statusCode(status: number): string {
  switch (status) {
    case 400: return "VALIDATION";
    case 401: return "UNAUTHENTICATED";
    case 402: return "PAYMENT_REQUIRED";
    case 403: return "FORBIDDEN";
    case 404: return "NOT_FOUND";
    case 409: return "CONFLICT";
    case 429: return "RATE_LIMITED";
    default: return status >= 500 ? "INTERNAL" : "ERROR";
  }
}

/** Non-200 success or extra headers: return `reply(201, data)` from a handler. */
export class Reply<T> {
  constructor(
    readonly status: number,
    readonly data: T,
    readonly headers?: Record<string, string>,
  ) {}
}
export function reply<T>(status: number, data: T, headers?: Record<string, string>): Reply<T> {
  return new Reply(status, data, headers);
}

interface ErrorBody {
  ok: false;
  error: { code: string; message: string; [k: string]: unknown };
  requestId: string;
}

function errorResponse(
  requestId: string,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): NextResponse {
  const body: ErrorBody = { ok: false, error: { code, message, ...extra }, requestId };
  return NextResponse.json(body, { status });
}

/**
 * Wrap a /api/v1 route handler. Success → { ok: true, data, requestId } (200,
 * or Reply's status/headers). Errors → the envelope with a typed code:
 * EngineError via ENGINE_HTTP (SEQ_CONFLICT carries current_seq per doc 08 §4),
 * PaymentRequiredError → 402, AuthError → 401, HttpError → its status,
 * ZodError → 400 with issues.
 */
export async function v1<T>(fn: () => Promise<T | Reply<T>>): Promise<NextResponse> {
  const requestId = randomUUID();
  try {
    const result = await fn();
    if (result instanceof Reply) {
      return NextResponse.json(
        { ok: true, data: result.data, requestId },
        { status: result.status, headers: result.headers },
      );
    }
    return NextResponse.json({ ok: true, data: result, requestId });
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      return errorResponse(requestId, 400, "VALIDATION", "Invalid input", {
        issues: err.issues,
      });
    }
    if (EngineError.is(err)) {
      const status = ENGINE_HTTP[err.code] ?? 422;
      if (status >= 500) Sentry.captureException(err);
      // 409 contract (doc 08 §4): the client resyncs from current_seq.
      const extra =
        err.code === "SEQ_CONFLICT" &&
        typeof (err.data as { actualSeq?: unknown } | undefined)?.actualSeq === "number"
          ? { current_seq: (err.data as { actualSeq: number }).actualSeq }
          : undefined;
      return errorResponse(requestId, status, err.code, err.message, extra);
    }
    if (err instanceof PaymentRequiredError) {
      return errorResponse(requestId, 402, "PAYMENT_REQUIRED", err.message, {
        feature: err.featureKey,
      });
    }
    if (err instanceof AuthError) {
      return errorResponse(requestId, 401, "UNAUTHENTICATED", err.message);
    }
    if (err instanceof HttpError) {
      if (err.status >= 500) Sentry.captureException(err);
      return errorResponse(requestId, err.status, statusCode(err.status), err.message);
    }
    Sentry.captureException(err);
    const message = err instanceof Error ? err.message : "Server error";
    return errorResponse(requestId, 500, "INTERNAL", message);
  }
}

/** Parse + Zod-validate a JSON request body (malformed JSON → 400). */
export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  return schema.parse(raw);
}

// ---------------------------------------------------------------------------
// Cursor pagination (doc 08 §1): ?cursor=&limit=, opaque base64url cursor over
// the keyset (created_at, id). No X-Total-Count by design (expensive).
// ---------------------------------------------------------------------------

export interface ListQuery {
  cursor: { createdAt: string; id: string } | null;
  limit: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: createdAt, id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): { createdAt: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as {
      v?: unknown;
      id?: unknown;
    };
    if (typeof parsed.v !== "string" || typeof parsed.id !== "string") throw new Error("shape");
    return { createdAt: parsed.v, id: parsed.id };
  } catch {
    throw new HttpError(400, "Invalid cursor");
  }
}

/** Read ?cursor=&limit= off a request URL. */
export function listQuery(req: Request): ListQuery {
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  const parsed = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, "Invalid limit");
  const limit = Math.min(parsed, MAX_LIMIT);
  const rawCursor = url.searchParams.get("cursor");
  return { cursor: rawCursor ? decodeCursor(rawCursor) : null, limit };
}

/**
 * Build a Page from limit+1 keyset rows: callers over-fetch by one row to
 * detect a next page, then this trims and mints the cursor from the last kept
 * row's (created_at, id).
 */
export function page<T extends { id: string; created_at: string | Date }>(
  rows: T[],
  limit: number,
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(new Date(last.created_at).toISOString(), last.id)
      : null;
  return { items, nextCursor };
}
