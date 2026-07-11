// The hero's proof (v3/07 §5): a fixture card that fills itself in —
// create → generate → live — using the product's real scorebug shape, not a
// screenshot. Pure CSS keyframes on a staggered loop; static under
// prefers-reduced-motion. Server-safe (no hooks).

const STEPS = ["You name it", "We draw it", "It goes live"] as const;

const FIXTURES = [
  { home: "Riverside A", away: "Northside", hs: 21, as: 18, court: "Court 1" },
  { home: "Falcons", away: "Comets", hs: 19, as: 21, court: "Court 2" },
  { home: "Riverside B", away: "Southpaw", hs: 11, as: 9, court: "Court 3" },
] as const;

export function HeroFixtureDemo() {
  return (
    <div className="hfx mx-auto mt-10 w-full max-w-md" aria-hidden>
      <style>{`
        .hfx-card { animation: hfx-in 700ms cubic-bezier(.2,.7,.3,1) both; }
        .hfx-card:nth-child(2) { animation-delay: 350ms; }
        .hfx-card:nth-child(3) { animation-delay: 700ms; }
        .hfx-live { animation: hfx-pulse 1.6s ease-in-out 1.2s infinite; }
        @keyframes hfx-in {
          from { opacity: 0; transform: translateY(10px) scale(.98); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes hfx-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .35; }
        }
        @media (prefers-reduced-motion: reduce) {
          .hfx-card, .hfx-live { animation: none; }
        }
      `}</style>

      <div className="mb-3 flex items-center justify-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-purple-400">
        {STEPS.map((s, i) => (
          <span key={s} className="flex items-center gap-2">
            {i > 0 && <span className="text-purple-200">→</span>}
            {s}
          </span>
        ))}
      </div>

      <div className="space-y-2">
        {FIXTURES.map((f, i) => (
          <div
            key={f.home}
            className="hfx-card flex items-center justify-between rounded-xl border border-purple-100 bg-white px-4 py-3 shadow-sm"
          >
            <div className="min-w-0 text-left">
              <p className="truncate text-sm font-semibold text-slate-800">
                {f.home} <span className="font-normal text-slate-400">vs</span> {f.away}
              </p>
              <p className="text-xs text-slate-400">{f.court} · Badminton · Group A</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-lg font-bold tabular-nums text-purple-900">
                {f.hs}–{f.as}
              </span>
              {i === 0 ? (
                <span className="hfx-live inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold uppercase text-red-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> Live
                </span>
              ) : (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
                  {i === 1 ? "Final" : "Up next"}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
