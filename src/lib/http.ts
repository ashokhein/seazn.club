import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthError } from "@/lib/auth";

/** Wraps a route handler with consistent JSON error handling. */
export function handler<T>(fn: () => Promise<T>) {
  return fn()
    .then((data) => NextResponse.json({ ok: true, data }))
    .catch((err: unknown) => {
      if (err instanceof ZodError) {
        return NextResponse.json(
          { ok: false, error: "Invalid input", issues: err.issues },
          { status: 400 },
        );
      }
      if (err instanceof AuthError) {
        return NextResponse.json(
          { ok: false, error: err.message },
          { status: 401 },
        );
      }
      const message = err instanceof Error ? err.message : "Server error";
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    });
}
