import Link from "next/link";
import { ticketTiers } from "@/lib/pricing-cards";
import type { Currency } from "@/lib/currency";
import { Reveal } from "./reveal";

/** Floodlit finale pricing (design/v3/12 §4.8): three ticket stubs, Event
 *  Pass glowing. Content comes from the shared pricing-cards source. */
export function TicketStubs({ currency }: { currency: Currency }) {
  return (
    <div className="flex flex-wrap justify-center gap-5">
      {ticketTiers(currency).map((t, i) => (
        <Reveal
          key={t.tier}
          className={`mk-stub relative w-64 rounded-xl border p-5 text-left ${
            t.glow
              ? "border-[var(--mk-lime)] shadow-[0_0_34px_rgba(163,230,53,0.22)]"
              : "border-[#3b2a6e]"
          }`}
          style={{
            animationDelay: `${i * 120}ms`,
            background: "linear-gradient(160deg,#241650,#1a0f3e)",
          }}
        >
          <span className="mk-stub-tear" aria-hidden />
          <span className="mk-stub-admit mk-display" aria-hidden>
            ADMIT ONE
          </span>
          <p
            className={`mk-display text-xs font-semibold tracking-[0.18em] ${
              t.glow ? "text-[var(--mk-lime)]" : "text-[#b7aede]"
            }`}
          >
            {t.tier}
          </p>
          <p className="mk-display my-1 text-4xl font-bold tabular-nums text-[var(--mk-cream)]">
            {t.price}
            {t.period ? (
              <span className="text-base font-medium text-[#b7aede]">{t.period}</span>
            ) : null}
          </p>
          <ul className="w-40 space-y-1 text-xs leading-relaxed text-[#cfc6ec]">
            {t.bullets.map((b) => (
              <li key={b}>
                <span className="text-[var(--mk-lime)]">✓</span> {b}
              </li>
            ))}
          </ul>
        </Reveal>
      ))}
      <p className="w-full">
        <Link
          href="/pricing"
          className="text-xs text-[#8d7fc0] underline hover:text-[var(--mk-lime)]"
        >
          Compare plans in detail →
        </Link>
      </p>
    </div>
  );
}
