// A JSON POST seam that keeps what `api()` throws away (v17 gap #293, Task 6).
//
// `lib/client.ts`'s `api()` collapses every failure to
// `new Error(payload.reason || payload.error || ...)`. Two things die there:
//
//  1. THE STATUS. Our routes distinguish their refusals by status, not by
//     prose — `setExtraOrgs` alone answers 400 (reselect an organisation), 409
//     (change plan), 422 (choose another number) and 423 (move an organisation
//     out), four different ACTIONS. A caller holding only a sentence can either
//     render the server's hardcoded English into a four-locale surface or say
//     "something went wrong" to all four. Both are wrong; the codebase's answer
//     is a pure `status -> DictionaryKey` map (`passCheckoutErrorKey` is the
//     reference), and that needs the status.
//  2. THE REST OF THE BODY. `handler`'s 402 branch spreads `...err.extra` next
//     to `feature_key`/`reason`, which is how `{ offer: "extra_org" }` reaches
//     the client (Task 5). `api()` reads `reason` and drops `offer` on the
//     floor, so a caller cannot tell "upgrade your plan" from "buy a rider".
//
// Deliberately a NEW seam rather than a widening of `api()`. `api()` has many
// callers that depend on it throwing, and on it preferring `reason` over
// `error`; changing that under all of them to serve one page is how a small
// billing fix becomes an unrelated regression.
//
// No React and no `server-only` — so it unit-tests under the node vitest env
// with a hand-rolled `fetch`, and a "use client" island can import it. Its one
// import (`lib/org-scope`) holds to the same rule for the same reason. No
// `"use client"` directive, deliberately — same as
// lib/billing-checkout-client.ts: the importing island already establishes the
// boundary, and leaving it off keeps the module usable from either side.

import { orgScopeHeaders } from "@/lib/org-scope";

/** A POST that either produced `data` or did not, with everything a caller
 *  needs to CHOOSE ITS OWN COPY on the failure branch. */
export type PostResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      /** HTTP status, or null when no response arrived at all (a rejected
       *  fetch: offline, DNS, an aborted request). Null is not 500 — nothing is
       *  known about the server's opinion, so it must route to "try again"
       *  rather than to a confident diagnosis. */
      status: number | null;
      /** The server's own sentence: hardcoded English, and on an unexpected
       *  500 a raw `err.message` (lib/http.ts). Useful to LOG, never to render
       *  in a localised surface — choose copy from `status` instead. */
      error: string;
      /** The whole parsed payload, so fields outside the envelope survive —
       *  notably a 402's `offer` / `feature_key` / `reason`. `{}` when the body
       *  was not JSON. */
      body: Record<string, unknown>;
    };

const FALLBACK_ERROR = "Request failed.";

/**
 * POST `json` to `url` and never throw.
 *
 * Mirrors `api()`'s success contract exactly — the payload's `data` — so a
 * route can be moved between the two seams without its callers changing shape.
 * A body with `ok: false` is a failure even on a 2xx, matching `api()`.
 *
 * @param fetchFn injectable so the seam is testable without a DOM or a network.
 * @param pathname likewise: the console path this write is being made from.
 *   Defaults to the live location, which is what a browser caller wants.
 */
export async function postJson<T = unknown>(
  url: string,
  json: unknown,
  fetchFn: typeof fetch = fetch,
  pathname?: string | null,
): Promise<PostResult<T>> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // WHICH organisation this write is for, taken from the URL the user is
        // looking at rather than from the `seazn_org` cookie the server would
        // otherwise read: that cookie is re-pointed by an effect running after
        // the destination page paints, so a save inside the window was applied
        // to the PREVIOUS billing group (v17 gap #334).
        ...orgScopeHeaders(pathname),
      },
      body: JSON.stringify(json),
    });
  } catch {
    return { ok: false, status: null, error: FALLBACK_ERROR, body: {} };
  }

  const payload = await res.json().catch(() => null);
  const body: Record<string, unknown> =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  if (!res.ok || body.ok === false) {
    return {
      ok: false,
      // A real Response always carries a numeric status; a hand-rolled double
      // in a test may not, and `undefined` leaking into `number | null` would
      // route a known refusal into the generic "something went wrong" copy.
      status: typeof res.status === "number" ? res.status : null,
      error: typeof body.error === "string" ? body.error : FALLBACK_ERROR,
      body,
    };
  }
  return { ok: true, data: body.data as T };
}
