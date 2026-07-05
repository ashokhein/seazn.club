import "server-only";
// ISR invalidation for the public dashboard (doc 09 §3): the SAME service-
// layer writes that publish realtime fire these tags. Fire-and-forget — a
// failed revalidation must never roll back a scoring write, and unit tests
// call use-cases outside a request scope where revalidateTag would throw.
import { revalidateTag } from "next/cache";
import { divisionTag, competitionTag } from "./data";

export function fireDivisionRevalidate(divisionId: string, competitionId?: string): void {
  try {
    // Next 16 signature: second arg = stale-while-revalidate window ('max' =
    // serve stale while fresh regenerates — right for spectator pages).
    revalidateTag(divisionTag(divisionId), "max");
    if (competitionId) revalidateTag(competitionTag(competitionId), "max");
  } catch {
    // outside a Next request scope (tests, scripts) — nothing to invalidate
  }
}
