import Link from "next/link";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";
import { Reveal } from "./reveal";

/** Matchday tools (design/v3/12 §4.5): three product-real cards, each with a
 *  tiny once-on-view animation. Replaces the emoji feature grid.
 *  Copy comes from the `marketing` dict the [lang] home page resolves. */
export function MatchdayTools({ dict }: { dict: Dict }) {
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
        <h3 className="mb-1 font-semibold text-slate-800">{t(dict, "home.tools.live.title")}</h3>
        <p className="text-sm text-slate-500">{t(dict, "home.tools.live.body")}</p>
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
          <h3 className="mb-1 font-semibold text-slate-800">{t(dict, "home.tools.schedule.title")}</h3>
          <p className="text-sm text-slate-500">{t(dict, "home.tools.schedule.body")} →</p>
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
        <h3 className="mb-1 font-semibold text-slate-800">{t(dict, "home.tools.standings.title")}</h3>
        <p className="text-sm text-slate-500">{t(dict, "home.tools.standings.body")}</p>
      </Reveal>
    </div>
  );
}

const KIT = ["registration", "print", "roles", "secure"] as const;

export function AlsoInTheKit({ dict }: { dict: Dict }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {KIT.map((k) => (
        <li key={k} className="text-sm">
          <p className="font-semibold text-slate-800">{t(dict, `home.kit.${k}.label`)}</p>
          <p className="text-slate-500">{t(dict, `home.kit.${k}.body`)}</p>
        </li>
      ))}
    </ul>
  );
}
