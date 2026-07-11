import type { PreviewPhase } from "@/server/usecases/stages";
import { Reveal } from "./reveal";

/** Animated PreviewPhase renderer for marketing surfaces (design/v3/12 §4.4).
 *  The existing FormatPreviewView stays untouched for /help + the wizard.
 *  Single-letter engine labels (A…P) become generated club names; every other
 *  token (Seed 1, Winner of R1 #2) is engine truth and passes through. */
export function DrawRenderer({ phases, names }: { phases: PreviewPhase[]; names: string[] }) {
  const nameFor = (token: string) => {
    if (/^[A-Z]$/.test(token)) {
      const idx = token.charCodeAt(0) - 65;
      return names[idx] ?? token;
    }
    return token;
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {phases.map((phase, pi) => (
        <div key={phase.title + pi}>
          <h3 className="mk-display mb-2 text-lg font-semibold text-purple-950">{phase.title}</h3>
          {phase.note ? <p className="text-sm text-slate-500">{phase.note}</p> : null}
          <div className="space-y-4">
            {phase.sections.map((s) => (
              <Reveal key={s.title} className="rounded-xl border border-purple-100 bg-white p-4">
                <p className="label mb-2 text-xs">{s.title}</p>
                <ul className="space-y-1.5">
                  {s.matches.map((m, i) => (
                    <li
                      key={i}
                      className="mk-draw-row flex items-center justify-between rounded-lg bg-[var(--mk-light-violet)] px-3 py-1.5 text-sm text-slate-800"
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <span className="truncate">{nameFor(m.home)}</span>
                      <span className="mx-2 text-xs text-purple-400">vs</span>
                      <span className="truncate text-right">{nameFor(m.away)}</span>
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
