// Scoring-fidelity → entitlement mapping (doc 14 §4, doc 10 §2 rule 2).
// Derived from each SportModule's own `fidelityTiers` declaration — never a
// hand-kept table — so a new module (or a new fine event type) is gated the
// moment it declares itself. Pure: safe to unit-test without a DB.
import type { AnySportModule } from "@seazn/engine/sport";

/**
 * The feature key an org must hold to append `eventType` to a fixture of this
 * module, or null when the event is free (doc 14 §1: Tier 0/1 always pass).
 *
 * An event type may appear in several tiers (football.goal is both the Tier 1
 * final score and part of the Tier 2 timeline); the LOWEST tier that accepts
 * it wins — coarse entry must never be blocked. Unknown types return null:
 * the module's eventSchema rejects them downstream with a 422, which is the
 * right error (not a paywall).
 */
export function requiredFeatureForEvent(
  sportModule: AnySportModule,
  eventType: string,
): string | null {
  if (eventType.startsWith("core.")) return null; // start/void/finalize… are free
  let lowest: { tier: number; entitlement?: string } | null = null;
  for (const t of sportModule.fidelityTiers) {
    if (!t.eventTypes.includes(eventType)) continue;
    if (lowest === null || t.tier < lowest.tier) lowest = t;
  }
  if (lowest === null || lowest.tier <= 1) return null;
  return lowest.entitlement ?? null;
}
