"use client";
// Event Pass discovery inside a competition (spec D3, task 19).
//
// Until now `routes.competitionUpgrade` had exactly ONE inbound link — the
// paywall in <UpgradeGate>. The $29 pass was therefore only findable by an
// organiser who had already been blocked, which is the worst moment to meet a
// price. This is the same offer, in the competition's own chrome, before the
// refusal.
//
// It reads `usePassGateState()` rather than re-deriving anything: the
// competition layout already resolved BOTH facts (pass row present, org on a
// paid plan) once per request, and there must stay exactly one definition of
// which upsell is honest here.
//
//   paid_plan → nothing. Pro's matrix is a strict superset of the pass, so an
//               invitation to spend $29 here sells a DOWNGRADE (the pass grants
//               10 AI runs per division against pro's 20, and 64 entrants per
//               division against pro's 256). This is the defect fixed in the
//               gate by f70b8e52; a new surface must not reintroduce it.
//   held      → the "on" signal, never a buy link. Presence is ROW EXISTENCE:
//               a staff-granted pass has a null `stripe_payment_intent` and is
//               fully active, so it must read as active here too (spec D1).
//   none      → the offer.
//
// Outside a competition there is no provider and the hook answers "none", so
// this component must never be mounted where `href` cannot name a competition.
import Link from "@/components/ui/console-link";
import { Ticket } from "lucide-react";
import { usePassGateState } from "@/components/competition-pass-provider";

export function CompetitionPassEntry({
  href,
  buyLabel,
  activeLabel,
  canBuy,
}: {
  /** routes.competitionUpgrade(orgSlug, compSlug). */
  href: string;
  /** "Event Pass — $29 one-time", priced on the server (currency is a cookie). */
  buyLabel: string;
  /** "Event Pass active". */
  activeLabel: string;
  /**
   * Can this viewer act on the offer? Editors get the link; everyone else gets
   * nothing rather than a price they cannot pay. The ACTIVE signal is not
   * gated — it is a fact about the competition, not an invitation.
   */
  canBuy: boolean;
}) {
  const gate = usePassGateState();

  if (gate === "paid_plan") return null;

  if (gate === "held") {
    // The console's floodlit "this is on" device (globals.css .app-eyebrow:
    // condensed caps, lime tick) — the same treatment task 17 gave the
    // pass-owned paywall, so one pass reads identically wherever it surfaces.
    return (
      <p data-pass-held className="app-eyebrow mb-1">
        {activeLabel}
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
