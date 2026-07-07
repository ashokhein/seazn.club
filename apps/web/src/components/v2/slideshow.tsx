"use client";

// Full-screen noticeboard slideshow: rotates slides every 9 s. Data refresh
// is entitlement-split (doc 09 §4 pattern, same as live-score): Pro orgs
// subscribe to `division:{id}` realtime broadcasts and refresh on push;
// everyone else (and any subscription failure) falls back to 45 s polling.
// Escape returns to the console. Dark, large-type, made for a TV.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import type { Slide } from "@/server/slideshow-data";

const SLIDE_MS = 9000;
const POLL_MS = 45_000;
const SUBSCRIBED_POLL_MS = 5 * 60_000; // safety net once push is live

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
  divisionIds = [],
  realtime = false,
}: {
  title: string;
  slides: Slide[];
  backHref: string;
  /** Divisions on show — realtime subscription topics. */
  divisionIds?: string[];
  /** Org `realtime` entitlement, resolved server-side. */
  realtime?: boolean;
}) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [clock, setClock] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    if (slides.length < 2) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % slides.length), SLIDE_MS);
    return () => clearInterval(t);
  }, [slides.length]);

  // Realtime push (Pro): refresh on any division's score/schedule broadcast.
  // Any failure leaves `subscribed` false and the poll below takes over.
  // Keyed on the joined ids — router.refresh() hands us a fresh array each
  // time and identity-keying would tear down the sockets on every refresh.
  const divisionKey = divisionIds.join(",");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const ids = divisionKey ? divisionKey.split(",") : [];
    if (!realtime || ids.length === 0) return;
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let cancelled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const channels: any[] = [];
    const onPush = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => router.refresh(), 1000);
    };
    (async () => {
      try {
        const { supabaseBrowser } = await import("@/lib/supabase-browser");
        const sb = supabaseBrowser();
        for (const id of ids) {
          if (cancelled) return;
          channels.push(
            sb
              .channel(`division:${id}`)
              .on("broadcast", { event: "state_changed" }, onPush)
              .on("broadcast", { event: "schedule_changed" }, onPush)
              .subscribe((status: string) => {
                if (!cancelled && status === "SUBSCRIBED") setSubscribed(true);
              }),
          );
        }
      } catch {
        // env missing / websocket refused → polling
      }
    })();
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setSubscribed(false);
      for (const ch of channels) void ch.unsubscribe?.();
    };
  }, [realtime, divisionKey, router]);

  // Polling — primary refresh on Community, slow safety net once push is live.
  useEffect(() => {
    const t = setInterval(
      () => router.refresh(),
      subscribed ? SUBSCRIBED_POLL_MS : POLL_MS,
    );
    return () => clearInterval(t);
  }, [router, subscribed]);

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
  const liveCount = slides.reduce(
    (n, s) =>
      s.kind === "fixtures" ? n + s.items.filter((i) => i.status === "in_play").length : n,
    0,
  );

  const medal = ["bg-amber-300 text-amber-950", "bg-slate-300 text-slate-900", "bg-orange-400/80 text-orange-950"];

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
      {/* Ambient backdrop — slow drifting glows, made for a TV left on all day */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="animate-blob absolute -left-48 -top-48 h-[36rem] w-[36rem] rounded-full bg-purple-600/20 blur-3xl" />
        <div className="animate-blob absolute -bottom-56 -right-40 h-[42rem] w-[42rem] rounded-full bg-fuchsia-600/10 blur-3xl [animation-delay:-7s]" />
        <div className="animate-blob absolute left-1/2 top-1/3 h-96 w-96 -translate-x-1/2 rounded-full bg-indigo-600/10 blur-3xl [animation-delay:-3.5s]" />
      </div>

      {/* Header */}
      <header className="relative flex items-center justify-between px-10 py-6">
        <div className="flex min-w-0 items-center gap-4">
          <Link
            href={backHref}
            aria-label="Exit slideshow"
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-slate-300 ring-1 ring-inset ring-white/15 transition hover:bg-white/20 hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
            <span className="hidden sm:inline">Back</span>
          </Link>
          <h1 className="truncate text-2xl font-bold tracking-tight">{title}</h1>
          {liveCount > 0 && (
            <span className="flex shrink-0 items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1 text-sm font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-400" />
              LIVE
            </span>
          )}
        </div>
        {clock && (
          <span className="text-2xl font-medium tabular-nums text-slate-400">{clock}</span>
        )}
      </header>

      {/* Slide — keyed on index so each rotation re-runs the entrance animation */}
      <main className="relative flex flex-1 flex-col justify-center px-10 pb-10">
        {!slide ? (
          <div className="text-center">
            <p className="animate-trophy mb-4 text-6xl">🏟️</p>
            <p className="text-2xl text-slate-400">Nothing to show yet</p>
            <p className="mt-2 text-lg text-slate-600">
              Generate fixtures and this board comes alive.
            </p>
          </div>
        ) : (
          <div key={index} className="animate-slide-in mx-auto w-full max-w-5xl">
            <p className="mb-1 text-center text-lg font-semibold uppercase tracking-widest text-purple-400">
              {slide.division}
            </p>
            <h2 className="mb-8 text-center text-5xl font-black tracking-tight">
              {slide.kind === "standings" ? slide.caption : slide.title}
            </h2>

            {slide.kind === "standings" ? (
              <div>
                <div className="grid grid-cols-[3.5rem_1fr_repeat(4,3.5rem)_5.5rem] gap-x-4 px-6 pb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
                  <span>#</span>
                  <span>Entrant</span>
                  <span className="text-right">P</span>
                  <span className="text-right">W</span>
                  <span className="text-right">D</span>
                  <span className="text-right">L</span>
                  <span className="text-right">Pts</span>
                </div>
                <div className="space-y-1.5">
                  {slide.rows.slice(0, 10).map((r, i) => (
                    <div
                      key={r.rank + r.name}
                      className={`grid grid-cols-[3.5rem_1fr_repeat(4,3.5rem)_5.5rem] items-center gap-x-4 rounded-xl px-6 py-3 text-2xl ring-1 ring-inset ${
                        i === 0
                          ? "bg-gradient-to-r from-amber-400/15 via-white/[0.04] to-transparent ring-amber-400/20"
                          : "bg-white/[0.04] ring-white/5"
                      }`}
                    >
                      <span>
                        {i < 3 ? (
                          <span
                            className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-lg font-bold ${medal[i]}`}
                          >
                            {r.rank}
                          </span>
                        ) : (
                          <span className="pl-3 text-xl text-slate-500">{r.rank}</span>
                        )}
                      </span>
                      <span className="flex min-w-0 items-center gap-3 truncate font-semibold">
                        {r.name}
                        {i === 0 && <span className="animate-trophy shrink-0 text-xl">🏆</span>}
                      </span>
                      <span className="text-right text-xl text-slate-400">{r.played}</span>
                      <span className="text-right text-xl text-slate-400">{r.won}</span>
                      <span className="text-right text-xl text-slate-400">{r.drawn}</span>
                      <span className="text-right text-xl text-slate-400">{r.lost}</span>
                      <span className="text-right text-3xl font-black text-purple-300">
                        {r.points}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <ul className="space-y-3">
                {slide.items.map((f, i) => {
                  const live = f.status === "in_play";
                  return (
                    <li
                      key={i}
                      className={`grid grid-cols-[1fr_auto_1fr_auto] items-center gap-6 rounded-2xl px-8 py-5 ring-1 ring-inset ${
                        live
                          ? "bg-emerald-400/[0.06] ring-emerald-400/30"
                          : "bg-white/[0.04] ring-white/5"
                      }`}
                    >
                      <span className="min-w-0 truncate text-right text-2xl font-semibold">
                        {f.home}
                      </span>
                      <span
                        className={`shrink-0 rounded-xl px-4 py-1.5 text-center text-3xl font-black tabular-nums ${
                          f.line ? "bg-white/5 text-purple-300" : "text-lg font-semibold text-slate-500"
                        }`}
                      >
                        {f.line ?? "vs"}
                      </span>
                      <span className="min-w-0 truncate text-2xl font-semibold">{f.away}</span>
                      <span
                        className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-sm font-medium ${
                          live
                            ? "bg-emerald-400/15 text-emerald-300"
                            : "bg-white/5 text-slate-400"
                        }`}
                      >
                        {live && (
                          <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-400" />
                        )}
                        {STATUS_LABEL[f.status] ?? f.status}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </main>

      {/* Footer — per-slide progress bar + jump dots */}
      {slides.length > 1 && (
        <footer className="relative pb-6">
          <div className="mx-auto mb-4 h-1 max-w-lg overflow-hidden rounded-full bg-white/10">
            <div
              key={index}
              className="animate-slide-progress h-full rounded-full bg-gradient-to-r from-purple-400 to-fuchsia-400"
              style={{ animationDuration: `${SLIDE_MS}ms` }}
            />
          </div>
          <div className="flex items-center justify-center gap-2">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Slide ${i + 1}`}
                onClick={() => setIndex(i)}
                className={`h-2 rounded-full transition-all ${
                  i === index ? "w-6 bg-purple-400" : "w-2 bg-slate-700 hover:bg-slate-500"
                }`}
              />
            ))}
          </div>
        </footer>
      )}
    </div>
  );
}
