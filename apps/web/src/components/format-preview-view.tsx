// Renders the engine's format preview (previewDivisionFixtures output) —
// "here is exactly what you get" (v3/06 §4). Shared by the /help gallery
// pages, marketing /formats and the picker's How-this-works panel.
import type { PreviewPhase } from "@/server/usecases/stages";

export function FormatPreviewView({ phases }: { phases: PreviewPhase[] }) {
  return (
    <div className="space-y-5">
      {phases.map((phase, i) => (
        <section key={i} className="rounded-2xl border border-purple-100 bg-purple-50/30 p-4">
          <h4 className="font-display text-sm font-semibold uppercase tracking-[0.14em] text-purple-800">
            {phase.title}
          </h4>
          {phase.note ? (
            <p className="mt-1.5 text-sm italic text-slate-600">{phase.note}</p>
          ) : null}
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {phase.sections.map((section) => (
              <div key={section.title}>
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {section.title}
                </p>
                <ul className="space-y-1">
                  {section.matches.map((m, j) => (
                    <li
                      key={j}
                      className="flex items-center gap-2 rounded-lg bg-white px-3 py-1.5 text-sm text-slate-700 shadow-sm"
                    >
                      <span className="min-w-0 flex-1 truncate text-right font-medium">
                        {m.home}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] uppercase text-purple-400">
                        vs
                      </span>
                      <span className="min-w-0 flex-1 truncate font-medium">{m.away}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
