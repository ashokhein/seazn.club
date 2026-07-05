"use client";

// Fetch helper for the /api/v1 envelope ({ ok, data | error, requestId } —
// doc 08 §1). Errors carry the typed code so callers can branch on
// SEQ_CONFLICT (resync) and PAYMENT_REQUIRED (upgrade gate).
export class ApiV1Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiV1Error";
  }
}

export async function apiV1<T = unknown>(
  url: string,
  options?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = options ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const payload = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    data?: T;
    error?: { code?: string; message?: string; [k: string]: unknown };
  };
  if (!res.ok || payload.ok === false) {
    const { code = "UNKNOWN", message, ...extra } = payload.error ?? {};
    throw new ApiV1Error(message ?? `Request failed (${res.status})`, res.status, code, extra);
  }
  return payload.data as T;
}
