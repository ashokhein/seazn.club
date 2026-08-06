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
//   ended     → the org bought this competition's pass and it has STOPPED
//               applying — the competition reached a terminal status, or ran
//               past its end date plus grace (SPEC-4 §7). Three things are true
//               at once and the card has to hold all three: the pass is not
//               lifting anything any more, the row is never deleted, and it can
//               never be re-bought (pass-checkout refuses on an existing row,
//               and `competition_passes` is keyed on competition_id alone). So
//               this state is neither "held" — saying "Event Pass M active" over
//               a pass the resolver stopped honouring was the literal v17 gap
//               #301 P1 defect — nor "none", which would put the buy link on a
//               purchase the API will refuse. It is its own card, and it points
//               at the two things that CAN still help: next season, and a plan.
//   closed    → the competition is past the line and NEVER held a pass (#376).
//               Not `ended` (that card reports a purchase stopping, and there
//               was no purchase) and not `none` (that one offers a sale the
//               route answers with 410 Gone). One link, chosen by reason: a
//               finished competition points at next season, a stale end date
//               points at the settings form that makes the pass buyable again.
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
import {
  usePassGateState,
  usePassLockReason,
  usePassRung,
} from "@/components/competition-pass-provider";
import type { PassKey } from "@/lib/currency";
// Type-only. `@/lib/entitlements` imports postgres and ioredis and carries no
// `server-only` marker, so a VALUE import from this "use client" file would drag
// both into the browser graph. The lock is JUDGED on the server (the competition
// layout calls `passLockReason`); this file only renders the verdict.
import type { PassLockReason } from "@/lib/entitlements";

export function CompetitionPassEntry({
  href,
  buyLabel,
  activeLabels,
  endedLabel,
  endedReasons,
  closedLinks,
  nextEditionHref,
  nextEditionLabel,
  goProHref,
  goProLabel,
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
  /** "Event Pass ended" — `pass.entry.ended`. Deliberately NOT rung-named: it is
   *  reused verbatim by the paywall, the upgrade page and the billing purchase
   *  list, and the rung is not resolvable on all of them. */
  endedLabel: string;
  /**
   * WHY it ended, one finished sentence per lock reason —
   * `passEndedReasons(dict)`.
   *
   * A `Record<PassLockReason, string>` for the same reason `activeLabels` is a
   * `Record<PassKey, string>`: the page holds the dictionary and this island
   * holds the verdict, and a third lock reason must be a compile error at the
   * page rather than an ended card that silently explains nothing. It also keeps
   * the WORDING one step from `passLockReason` itself — the function that
   * decides is the function whose answer selects the sentence, so the copy
   * cannot disagree with the resolver that enforces the lock.
   */
  endedReasons: Record<PassLockReason, string>;
  /**
   * The one link the `closed` state offers, per lock reason (#376).
   *
   * A `Record<PassLockReason, …>` for the same reason `endedReasons` is one:
   * the page holds the dictionary and the routes, this island holds the
   * verdict, and a third lock reason must be a compile error at the page
   * rather than a card that silently links somewhere wrong. The two arms lead
   * to genuinely different places — a finished competition's next move is next
   * season, a stale end date's next move is the settings form — so this is a
   * Record of `{href,label}`, not a Record of labels over one href.
   */
  closedLinks: Record<PassLockReason, { href: string; label: string }>;
  /** routes.competitionNew(orgSlug) — the blank new-competition form. Never a
   *  copy of this one: no copy-competition feature exists, so a link promising a
   *  duplicate would be a promise the product cannot keep. */
  nextEditionHref: string;
  nextEditionLabel: string;
  /** routes.billing(orgSlug). The pass cannot come back for THIS competition, so
   *  a plan is the only thing that still lifts it — the one honest upsell here. */
  goProHref: string;
  goProLabel: string;
  /**
   * Can this viewer act on the offer? Editors get the link; everyone else gets
   * nothing rather than a price they cannot pay. The ACTIVE and ENDED signals
   * are not gated — they are facts about the competition, not invitations. (Both
   * links inside the ended card lead to pages that gate themselves.)
   */
  canBuy: boolean;
}) {
  const gate = usePassGateState();
  const rung = usePassRung();
  const lockReason = usePassLockReason();

  if (gate === "paid_plan") return null;

  if (gate === "closed") {
    // Editor-gated, unlike the ended card. The ended card shows to everyone
    // because it is a FACT about the competition; this state's entire content
    // is an action link, and a lone link shown to someone who cannot create a
    // competition or edit its dates is noise, not information.
    //
    // `lockReason` cannot be null here (usePassGateState returns "closed" only
    // when it is set); the guard is what keeps the Record lookup total rather
    // than an assertion.
    if (!canBuy || lockReason === null) return null;
    const link = closedLinks[lockReason];
    return (
      <p data-pass-closed data-pass-closed-reason={lockReason} className="mb-1">
        <Link
          href={link.href}
          data-pass-closed-link
          // min-h-11 is the 44px touch target; the negative margin keeps the
          // chip's optical position while the tappable box grows on mobile.
          className="-my-1 inline-flex min-h-11 items-center text-xs font-semibold text-purple-700 underline decoration-purple-300 underline-offset-2 hover:text-purple-800 hover:decoration-purple-500"
        >
          {link.label} →
        </Link>
      </p>
    );
  }

  if (gate === "ended") {
    // The same ticket, torn. Deliberately built from the buy pill's parts with
    // the floodlight off — Ticket icon, one line of label, the console's slate —
    // rather than as a new kind of banner: an organiser has to read this as the
    // thing that used to be lit, not as a warning about something else.
    //
    // `lockReason` cannot be null here (usePassGateState returns "ended" only
    // when it is set), and the sentence is OMITTED rather than defaulted if that
    // ever changes: an "Event Pass ended" with no reason is thin, but an ended
    // pass explained by the wrong reason tells an organiser whose end date is
    // merely stale that their competition is over.
    return (
      <div
        data-pass-ended
        data-pass-ended-reason={lockReason ?? undefined}
        className="mb-1 max-w-md rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600"
      >
        <p className="flex items-center gap-1.5 font-semibold text-slate-700">
          <Ticket className="h-3.5 w-3.5 shrink-0 text-slate-400" strokeWidth={2} aria-hidden />
          {endedLabel}
        </p>
        {lockReason && <p className="mt-1">{endedReasons[lockReason]}</p>}
        {/* Wrapping, and gapped in both axes: at 375px these two labels do not
            fit on one line in any locale, and fr/nl run longer still. */}
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
          <Link
            href={nextEditionHref}
            data-pass-ended-next
            className="font-semibold text-purple-700 underline decoration-purple-300 underline-offset-2 hover:text-purple-800 hover:decoration-purple-500"
          >
            {nextEditionLabel}
          </Link>
          <Link
            href={goProHref}
            data-pass-ended-pro
            className="font-semibold text-purple-700 underline decoration-purple-300 underline-offset-2 hover:text-purple-800 hover:decoration-purple-500"
          >
            {goProLabel}
          </Link>
        </div>
      </div>
    );
  }

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
