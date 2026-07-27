"use client";
// Event Pass discovery inside a competition (spec D3, task 19).
//
// Until now `routes.competitionUpgrade` had exactly ONE inbound link — the
// paywall in <UpgradeGate>. The pass was therefore only findable by an
// organiser who had already been blocked, which is the worst moment to meet a
// price. This is the same offer, in the competition's own chrome, before the
// refusal.
//
// It reads `usePassGateState()` rather than re-deriving anything: the
// competition layout already resolved BOTH facts (pass row present, org on a
// paid plan) once per request, and there must stay exactly one definition of
// which upsell is honest here.
//
//   paid_plan → nothing. Pro's matrix is a strict superset of the pass's at
//               every key the pass lifts, so an invitation to buy one here
//               sells a DOWNGRADE. This is the defect fixed in the gate by
//               f70b8e52; a new surface must not reintroduce it.
//   held      → the "on" signal, never a buy link. Presence is ROW EXISTENCE:
//               a staff-granted pass has a null `stripe_payment_intent` and is
//               fully active, so it must read as active here too (spec D1). The
//               signal NAMES the rung (v17 #294) — nothing else in this
//               competition's chrome says whether the $29 or the $59 pass is
//               the one running.
//   none      → the offer.
//
// Outside a competition there is no provider and the hook answers "none", so
// this component must never be mounted where `href` cannot name a competition.
import Link from "@/components/ui/console-link";
import { Ticket } from "lucide-react";
import { usePassGateState, usePassRung } from "@/components/competition-pass-provider";
import type { PassKey } from "@/lib/currency";

export function CompetitionPassEntry({
  href,
  buyLabel,
  activeLabels,
  canBuy,
}: {
  /** routes.competitionUpgrade(orgSlug, compSlug). */
  href: string;
  /** "Event Pass — from $29 one-time", priced on the server (currency is a
   *  cookie) at the ladder's FLOOR — the choice of rung lives on the page this
   *  links to. */
  buyLabel: string;
  /**
   * The held signal for EVERY rung ("Event Pass M active", "Event Pass L
   * active") — `passActiveLabels(dict)`.
   *
   * Both, because the page holds the dictionary and this island holds the rung:
   * only the competition layout read `competition_passes`, and only it knows
   * which pass is running. A `Record<PassKey, string>` rather than one string
   * plus a rung so a third rung is a compile error at the page, not a card that
   * silently keeps saying "M".
   */
  activeLabels: Record<PassKey, string>;
  /**
   * Can this viewer act on the offer? Editors get the link; everyone else gets
   * nothing rather than a price they cannot pay. The ACTIVE signal is not
   * gated — it is a fact about the competition, not an invitation.
   */
  canBuy: boolean;
}) {
  const gate = usePassGateState();
  const rung = usePassRung();

  if (gate === "paid_plan") return null;

  if (gate === "held") {
    // The console's floodlit "this is on" device (globals.css .app-eyebrow:
    // condensed caps, lime tick) — the same treatment task 17 gave the
    // pass-owned paywall, so one pass reads identically wherever it surfaces.
    //
    // `gate === "held"` is derived from the rung being non-null, so the
    // fallback cannot be reached; it is here so no rung is ever invented.
    return (
      <p data-pass-held data-pass-held-rung={rung ?? undefined} className="app-eyebrow mb-1">
        {activeLabels[rung ?? "event_pass"]}
      </p>
    );
  }

  if (!canBuy) return null;

  // Deliberately NOT `data-pass-cta` — that selector belongs to the paywall's
  // button and an e2e assertion counts it to prove the gate stopped re-selling
  // a held pass. A discovery link answering to it would break that proof.
  return (
    <Link
      href={href}
      data-pass-entry
      className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-lime-300 bg-lime-50 px-2.5 py-1 text-xs font-semibold text-lime-900 transition hover:border-lime-400 hover:bg-lime-100"
    >
      <Ticket className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
      {buyLabel}
    </Link>
  );
}
