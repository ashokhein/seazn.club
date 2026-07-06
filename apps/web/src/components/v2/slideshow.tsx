"use client";

// Full-screen noticeboard slideshow: rotates slides every 9 s, silently
// re-fetches server data every 45 s (router.refresh), Escape returns to the
// console. Dark, large-type, made for a TV across the hall.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Slide } from "@/server/slideshow-data";

const SLIDE_MS = 9000;
const REFRESH_MS = 45000;

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  in_play: "In play",
  decided: "Final",
  finalized: "Final",
  forfeited: "Forfeit",
  abandoned: "Abandoned",
  cancelled: "Cancelled",
};

export function Slideshow({
  title,
  slides,
  backHref,
}: {
  title: string;
  slides: Slide[];
  backHref: string;
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [clock, setClock] = useState<string | null>(null);

  useEffect(() => {
    if (slides.length < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % slides.length), SLIDE_MS);
    return () => clearInterval(t);
  }, [slides.length]);

  useEffect(() => {
    const t = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(t);
  }, [router]);

  useEffect(() => {
    const tick = () =>
      setClock(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    tick();
    const t = setInterval(tick, 10_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") router.push(backHref);
      if (e.key === "ArrowRight") setIndex((i) => (i + 1) % Math.max(slides.length, 1));
      if (e.key === "ArrowLeft")
        setIndex((i) => (i - 1 + Math.max(slides.length, 1)) % Math.max(slides.length, 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, backHref, slides.length]);

  const slide = slides[Math.min(index, Math.max(slides.length - 1, 0))];

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="flex items-center justify-between px-10 py-6">
        <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
        <div className="flex items-center gap-4 text-slate-400">
          {clock && <span className="text-2xl font-medium tabular-nums">{clock}</span>}
        </div>
      </header>

      {/* Slide */}
      <main className="flex flex-1 flex-col justify-center px-10 pb-10">
        {!slide ? (
          <p className="text-center text-2xl text-slate-500">
            Nothing to show yet — generate fixtures to get started.
          </p>
        ) : (
          <div>
            <p className="mb-1 text-lg font-semibold uppercase tracking-widest text-purple-400">
              {slide.division}
            </p>
            <h2 className="mb-6 text-4xl font-bold">
              {slide.kind === "standings" ? slide.caption : slide.title}
            </h2>

            {slide.kind === "standings" ? (
              <table className="w-full max-w-4xl text-xl">
                <thead>
                  <tr className="text-left text-base uppercase tracking-wider text-slate-500">
                    <th className="w-12 pb-2">#</th>
                    <th className="pb-2">Entrant</th>
                    <th className="w-14 pb-2 text-right">P</th>
                    <th className="w-14 pb-2 text-right">W</th>
                    <th className="w-14 pb-2 text-right">D</th>
                    <th className="w-14 pb-2 text-right">L</th>
                    <th className="w-20 pb-2 text-right">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {slide.rows.slice(0, 10).map((r) => (
                    <tr key={r.rank + r.name} className="border-t border-slate-800">
                      <td className="py-2.5 text-slate-500">{r.rank}</td>
                      <td className="py-2.5 font-medium">{r.name}</td>
                      <td className="py-2.5 text-right text-slate-300">{r.played}</td>
                      <td className="py-2.5 text-right text-slate-300">{r.won}</td>
                      <td className="py-2.5 text-right text-slate-300">{r.drawn}</td>
                      <td className="py-2.5 text-right text-slate-300">{r.lost}</td>
                      <td className="py-2.5 text-right text-2xl font-bold text-purple-300">
                        {r.points}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <ul className="max-w-4xl space-y-3 text-2xl">
                {slide.items.map((f, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between gap-6 rounded-xl bg-slate-900 px-6 py-4"
                  >
                    <span className="min-w-0 flex-1 truncate text-right">{f.home}</span>
                    <span className="shrink-0 font-bold text-purple-300">
                      {f.line ?? "vs"}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{f.away}</span>
                    <span
                      className={`shrink-0 rounded-full px-3 py-1 text-sm font-medium ${
                        f.status === "in_play"
                          ? "bg-amber-400/20 text-amber-300"
                          : "bg-slate-800 text-slate-400"
                      }`}
                    >
                      {STATUS_LABEL[f.status] ?? f.status}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </main>

      {/* Progress dots */}
      {slides.length > 1 && (
        <footer className="flex items-center justify-center gap-2 pb-6">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Slide ${i + 1}`}
              onClick={() => setIndex(i)}
              className={`h-2 rounded-full transition-all ${
                i === index ? "w-6 bg-purple-400" : "w-2 bg-slate-700"
              }`}
            />
          ))}
        </footer>
      )}
    </div>
  );
}
