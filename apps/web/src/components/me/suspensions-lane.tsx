"use client";

// SPEC-1 /me lane: the claimed player's own ACTIVE suspensions across every org,
// mirroring the officiating lane grammar (card + left rail). Red rail + card
// glyph; served progress in match pips. Renders nothing when the player is
// clear.
import { useMsg } from "@/components/i18n/dict-provider";
import { CardGlyph } from "@/components/discipline/card-glyph";
import { ServePips } from "@/components/discipline/serve-pips";
import type { MySuspension } from "@/server/usecases/me";

export function SuspensionsLane({ suspensions }: { suspensions: MySuspension[] }) {
  const msg = useMsg();
  if (suspensions.length === 0) return null;
  return (
    <section className="mb-8" aria-label={msg("disc.me.title")}>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        {msg("disc.me.title")}
      </h2>
      <ul className="space-y-2">
        {suspensions.map((s) => (
          <li
            key={s.id}
            className="card flex flex-wrap items-center justify-between gap-3 border-l-4 border-l-red-400 p-4"
          >
            <div className="flex min-w-0 items-center gap-3">
              <CardGlyph tone="red" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">{s.reason}</p>
                <p className="text-xs text-slate-400">
                  {s.division_name} · {s.competition_name} · {s.org_name}
                </p>
              </div>
            </div>
            <ServePips served={s.matches_served} total={s.matches_total} />
          </li>
        ))}
      </ul>
    </section>
  );
}
