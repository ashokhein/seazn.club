import Link from "next/link";
import { Reveal } from "./reveal";

/** Matchday tools (design/v3/12 §4.5): three product-real cards, each with a
 *  tiny once-on-view animation. Replaces the emoji feature grid. */
export function MatchdayTools() {
  return (
    <div className="grid gap-6 sm:grid-cols-3">
      <Reveal className="card p-5">
        <div className="mb-3 rounded-lg bg-[var(--mk-night)] p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="mk-display font-semibold text-[var(--mk-cream)]">Falcons</span>
            <span className="mk-odometer mk-display inline-block overflow-hidden font-bold tabular-nums text-[var(--mk-lime)]">
              <span className="mk-odometer-reel inline-flex flex-col leading-none">
                <span>19</span>
                <span>20</span>
                <span>21</span>
              </span>
            </span>
          </div>
          <div className="mt-1 flex items-center justify-between text-xs">
            <span className="mk-display font-semibold text-[var(--mk-cream)]">Comets</span>
            <span className="mk-display font-bold tabular-nums text-[var(--mk-cream)]">18</span>
          </div>
        </div>
        <h3 className="mb-1 font-semibold text-slate-800">Live scoring</h3>
        <p className="text-sm text-slate-500">
          Point-by-point from any phone. The public scoreboard updates the moment a rally ends.
        </p>
      </Reveal>

      <Reveal>
        <Link
          href="/scheduling"
          aria-label="Scheduling board"
          className="card block h-full p-5 transition hover:border-purple-300 hover:shadow-md"
        >
          <div className="mb-3 space-y-1.5 rounded-lg bg-[var(--mk-night)] p-3">
            {[0, 1, 2].map((lane) => (
              <div key={lane} className="relative h-3.5 overflow-hidden rounded bg-[#241650]">
                <span
                  className="mk-lane-block absolute inset-y-0.5 rounded-sm bg-[var(--mk-purple)]"
                  style={{ left: `${8 + lane * 14}%`, width: "26%", animationDelay: `${lane * 150}ms` }}
                />
              </div>
            ))}
          </div>
          <h3 className="mb-1 font-semibold text-slate-800">Scheduling board</h3>
          <p className="text-sm text-slate-500">
            Courts × time slots on one board. Clashes flagged before you publish. →
          </p>
        </Link>
      </Reveal>

      <Reveal className="card p-5">
        <div className="mb-3 overflow-hidden rounded-lg bg-[var(--mk-night)] p-3 text-xs">
          <div className="mk-swap-a flex justify-between text-[var(--mk-cream)]">
            <span>Riverside Aces</span>
            <span className="tabular-nums">7 pts</span>
          </div>
          <div className="mk-swap-b flex justify-between text-[var(--mk-cream)] opacity-80">
            <span>Oakwood Foxes</span>
            <span className="tabular-nums">7 pts</span>
          </div>
        </div>
        <h3 className="mb-1 font-semibold text-slate-800">Standings</h3>
        <p className="text-sm text-slate-500">
          Tables recompute the second a result lands — tie-breaks included.
        </p>
      </Reveal>
    </div>
  );
}

const KIT = [
  { label: "Registration & entry fees", body: "Public sign-up with capacity, waitlists and Stripe fees to your club." },
  { label: "Print & slideshow", body: "Brackets and standings for the noticeboard or the TV." },
  { label: "Roles & scorer seats", body: "Owners, admins, viewers, courtside scorer hand-off links." },
  { label: "Secure by default", body: "Per-tenant isolation, HSTS, CSRF protection out of the box." },
];

export function AlsoInTheKit() {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {KIT.map((k) => (
        <li key={k.label} className="text-sm">
          <p className="font-semibold text-slate-800">{k.label}</p>
          <p className="text-slate-500">{k.body}</p>
        </li>
      ))}
    </ul>
  );
}
