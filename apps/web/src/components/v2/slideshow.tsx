"use client";

// Full-screen noticeboard slideshow: rotates slides every 9 s. Data refresh
// is entitlement-split (doc 09 §4 pattern, same as live-score): Pro orgs
// subscribe to `division:{id}` realtime broadcasts and refresh on push;
// everyone else (and any subscription failure) falls back to 45 s polling.
// Escape returns to the console.
//
// Visual system: "courtside" broadcast package, same as the public pages —
// the whole board is the dark court slab, themeable per org via the --ps-*
// vars (Pro dashboard.branding passes themeStyle from the page), scoreboard
// type (Barlow Condensed via the slideshow layout), an accent keel under the
// masthead, and scorebug strips sized for a TV across the hall.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "@/components/ui/console-link";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import type { BracketSlideFixture, Slide } from "@/server/slideshow-data";
import { slideAt, stepFor } from "@/components/v2/slideshow-rotation";
import { doubleElimBracket, lbRowUnit, pagePlayoffBracket, rowCenter, twoSidedBracket } from "@seazn/engine/scheduling";

const SLIDE_MS = 9000;
const POLL_MS = 45_000;
const SUBSCRIBED_POLL_MS = 5 * 60_000; // safety net once push is live

const STATUS_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  in_play: "In play",
  // "Ended", not "Final" — the latter collides with the Final ROUND (F2).
  decided: "Ended",
  finalized: "Ended",
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
  themeStyle,
  logo = null,
  sponsors = [],
}: {
  title: string;
  slides: Slide[];
  backHref: string;
  /** Divisions on show — realtime subscription topics. */
  divisionIds?: string[];
  /** Org `realtime` entitlement, resolved server-side. */
  realtime?: boolean;
  /** --ps-* overrides from publicThemeStyle (Pro branding), resolved server-side. */
  themeStyle?: CSSProperties;
  /** Org logo URL (Pro branding), resolved server-side. */
  logo?: string | null;
  /** Org sponsor slots (v3/10 #5) — persistent strip above the footer, so
   *  sponsors are on screen the whole session, not one slide in N. */
  sponsors?: { name: string; logo?: string | null }[];
}) {
  const router = useRouter();
  // v13 (PROMPT-64): rotation is step-based so the in-play slide can pin —
  // slideAt interleaves it every other step while matches are live.
  const [step, setStep] = useState(0);
  const index = slideAt(step, slides);
  const setIndex = (target: number | ((i: number) => number)) =>
    setStep((s) => {
      const current = slideAt(s, slides);
      const next = typeof target === "function" ? target(current) : target;
      return stepFor(((next % Math.max(slides.length, 1)) + Math.max(slides.length, 1)) % Math.max(slides.length, 1), slides);
    });
  const [clock, setClock] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);

  useEffect(() => {
    if (slides.length < 2) return;
    const t = setInterval(() => setStep((s) => s + 1), SLIDE_MS);
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

  return (
    <div
      style={themeStyle}
      className="relative flex min-h-screen flex-col overflow-hidden bg-court text-court-ink"
    >
      {/* Static backdrop — soft accent wash from the top, vignette below.
          No animation: this board is left running on a TV all day. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-x-0 top-0 h-[55vh] bg-[radial-gradient(80%_100%_at_50%_0%,color-mix(in_srgb,var(--ps-accent)_18%,transparent),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(130%_80%_at_50%_115%,rgba(0,0,0,0.45),transparent_60%)]" />
      </div>

      {/* Masthead — court slab bar with the accent keel, echoing the public site. */}
      <header className="relative z-10">
        <div className="flex items-center gap-5 px-10 py-4">
          <Link
            href={backHref}
            aria-label="Exit slideshow"
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm font-medium text-court-muted ring-1 ring-inset ring-white/15 transition hover:bg-white/20 hover:text-court-ink"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={2} />
            <span className="hidden sm:inline">Back</span>
          </Link>
          {logo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt=""
              className="h-10 w-10 shrink-0 rounded-md bg-white/10 object-cover"
            />
          )}
          <h1 className="min-w-0 truncate font-display text-3xl font-semibold uppercase tracking-wide">
            {title}
          </h1>
          {liveCount > 0 && (
            <span className="flex shrink-0 items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1 font-display text-lg font-semibold uppercase tracking-wide text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
              <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-400" />
              Live
            </span>
          )}
          {clock && (
            <span className="ml-auto shrink-0 font-display text-3xl font-semibold tabular-nums text-court-muted">
              {clock}
            </span>
          )}
        </div>
        <div aria-hidden className="h-0.5 bg-accent" />
      </header>

      {/* Slide — keyed on index so each rotation re-runs the entrance animation */}
      <main className="relative z-10 flex flex-1 flex-col justify-center px-12 py-8">
        {!slide ? (
          <div className="text-center">
            <p className="font-display text-6xl font-bold uppercase tracking-tight">
              Nothing to show yet
            </p>
            <p className="mt-4 text-xl text-court-muted">
              Generate fixtures and this board comes alive.
            </p>
          </div>
        ) : (
          <div key={index} className="animate-slide-in mx-auto w-full max-w-6xl">
            <div className="mb-8">
              <p className="font-display text-xl font-semibold uppercase tracking-[0.28em] text-accent-line">
                {slide.division}
              </p>
              <h2 className="mt-1 font-display text-7xl font-bold uppercase leading-none tracking-tight">
                {slide.kind === "standings" ? slide.caption : slide.title}
              </h2>
              <div aria-hidden className="mt-4 h-1 w-20 bg-accent" />
            </div>

            {slide.kind === "bracket" ? (
              <BracketSlide fixtures={slide.fixtures} stageKind={slide.stageKind ?? "knockout"} />
            ) : slide.kind === "standings" ? (
              <div>
                <div className="grid grid-cols-[4rem_minmax(0,1fr)_repeat(4,4rem)_7rem] gap-x-5 px-6 pb-2 font-display text-base font-semibold uppercase tracking-[0.2em] text-court-muted">
                  <span>#</span>
                  <span>Entrant</span>
                  <span className="text-right">P</span>
                  <span className="text-right">W</span>
                  <span className="text-right">D</span>
                  <span className="text-right">L</span>
                  <span className="text-right">Pts</span>
                </div>
                <div className="space-y-2">
                  {slide.rows.slice(0, 10).map((r, i) => (
                    <div
                      key={r.rank + r.name}
                      className="relative grid grid-cols-[4rem_minmax(0,1fr)_repeat(4,4rem)_7rem] items-center gap-x-5 rounded-lg bg-white/[0.05] px-6 py-2.5 ring-1 ring-inset ring-white/10"
                    >
                      {i === 0 && (
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-0 w-1 rounded-l-lg bg-accent"
                        />
                      )}
                      <span>
                        {i === 0 ? (
                          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent font-display text-2xl font-bold text-accent-ink">
                            {r.rank}
                          </span>
                        ) : (
                          <span className="pl-2.5 font-display text-2xl font-semibold text-court-muted">
                            {r.rank}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 truncate font-display text-3xl font-semibold">
                        {r.name}
                      </span>
                      <span className="text-right font-display text-2xl tabular-nums text-court-muted">
                        {r.played}
                      </span>
                      <span className="text-right font-display text-2xl tabular-nums text-court-muted">
                        {r.won}
                      </span>
                      <span className="text-right font-display text-2xl tabular-nums text-court-muted">
                        {r.drawn}
                      </span>
                      <span className="text-right font-display text-2xl tabular-nums text-court-muted">
                        {r.lost}
                      </span>
                      <span className="text-right font-display text-4xl font-bold tabular-nums text-accent-line">
                        {r.points}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <ul className="space-y-2.5">
                {slide.items.map((f, i) => {
                  const live = f.status === "in_play";
                  return (
                    <li
                      key={i}
                      className={`relative grid grid-cols-[4rem_minmax(0,1fr)_auto_minmax(0,1fr)_6.5rem] items-center gap-x-6 rounded-lg px-7 py-3.5 ring-1 ring-inset ring-white/10 ${
                        live ? "bg-white/[0.09]" : "bg-white/[0.05]"
                      }`}
                    >
                      {live && (
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-0 w-1 rounded-l-lg bg-emerald-400"
                        />
                      )}
                      <span className="font-display text-xl font-semibold uppercase text-court-muted">
                        R{f.round}
                      </span>
                      <span className="flex min-w-0 items-center justify-end gap-3 text-right font-display text-4xl font-semibold">
                        <span className="min-w-0 truncate">{f.home}</span>
                        {f.homeLogo && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={f.homeLogo} alt="" aria-hidden className="h-10 w-10 shrink-0 rounded-md bg-white/90 object-contain p-0.5" />
                        )}
                      </span>
                      <span
                        className={`shrink-0 px-2 text-center font-display tabular-nums ${
                          f.line
                            ? "text-5xl font-bold text-accent-line"
                            : "text-2xl font-semibold text-court-muted"
                        }`}
                      >
                        {f.line ?? "vs"}
                      </span>
                      <span className="flex min-w-0 items-center gap-3 font-display text-4xl font-semibold">
                        {f.awayLogo && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={f.awayLogo} alt="" aria-hidden className="h-10 w-10 shrink-0 rounded-md bg-white/90 object-contain p-0.5" />
                        )}
                        <span className="min-w-0 truncate">{f.away}</span>
                      </span>
                      <span className="flex items-center justify-end gap-2 font-display text-lg font-semibold uppercase tracking-wide">
                        {live ? (
                          <>
                            <span className="animate-live-pulse h-2 w-2 rounded-full bg-emerald-400" />
                            <span className="text-emerald-300">Live</span>
                          </>
                        ) : (
                          <span className="text-court-muted">
                            {STATUS_LABEL[f.status] ?? f.status}
                          </span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </main>

      {/* Sponsor strip (v3/10 #5) — quiet, always on, venue-advertising. */}
      {sponsors.length > 0 && (
        <div className="relative z-10 flex items-center justify-center gap-8 px-10 pb-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.3em] text-court-muted">
            Sponsors
          </span>
          {sponsors.slice(0, 6).map((s) => (
            <span key={s.name} className="flex items-center gap-2 text-sm text-court-muted">
              {s.logo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={s.logo}
                  alt=""
                  className="h-6 w-6 rounded bg-white/90 object-contain p-0.5"
                />
              ) : null}
              {s.name}
            </span>
          ))}
        </div>
      )}

      {/* Footer — slide counter, per-slide progress rail, jump dots. */}
      {slides.length > 1 && (
        <footer className="relative z-10 flex items-center gap-6 px-10 pb-6">
          <span className="shrink-0 font-display text-lg font-semibold tabular-nums text-court-muted">
            {index + 1} / {slides.length}
          </span>
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              key={index}
              className="animate-slide-progress h-full rounded-full bg-accent"
              style={{ animationDuration: `${SLIDE_MS}ms` }}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {slides.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Slide ${i + 1}`}
                onClick={() => setIndex(i)}
                className={`h-2 rounded-full transition-all ${
                  i === index ? "w-6 bg-accent" : "w-2 bg-white/20 hover:bg-white/40"
                }`}
              />
            ))}
          </div>
        </footer>
      )}
    </div>
  );
}

// v13 (PROMPT-64) + G-audit: bracket slides for all three shapes — the
// knockout tree, the double-elim lanes, the stepladder rungs — from the same
// shared engine geometry as console / public / PDF.
function BracketSlide({
  fixtures,
  stageKind,
}: {
  fixtures: BracketSlideFixture[];
  stageKind: "knockout" | "double_elim" | "stepladder" | "page_playoff";
}) {
  if (stageKind === "stepladder") return <LadderSlide fixtures={fixtures} />;
  if (stageKind === "page_playoff") return <PagePlayoffSlide fixtures={fixtures} />;
  if (stageKind === "double_elim") return <DoubleElimSlide fixtures={fixtures} />;
  const result = twoSidedBracket(fixtures);
  if (!result.ok) return null;
  const layout = result.layout;
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const rowsPerSide = Math.max(1, layout.nodes.filter((n) => n.col === 0 && n.side === "L").length);
  const COL_W = 232;
  const SLOT_H = 96;
  const NODE_W = COL_W - 22;
  const NODE_H = 66;
  const totalW = (2 * layout.colsPerSide + 1) * COL_W;
  const totalH = Math.max(rowsPerSide * SLOT_H, SLOT_H * 2) + (layout.thirdPlaceId ? NODE_H + 18 : 0);
  const colX = (side: "L" | "R" | "center", col: number): number => {
    if (side === "L") return col * COL_W;
    if (side === "R") return (2 * layout.colsPerSide - col) * COL_W + (COL_W - NODE_W);
    return layout.colsPerSide * COL_W + (COL_W - NODE_W) / 2;
  };
  const nodeTop = (side: "L" | "R" | "center", col: number, row: number): number => {
    if (side === "center") {
      const centre = (rowsPerSide * SLOT_H) / 2 - NODE_H / 2;
      return row === 0 ? centre : centre + NODE_H + 18;
    }
    return rowCenter(col, row) * SLOT_H - NODE_H / 2;
  };
  return (
    <div className="overflow-x-auto">
      <div className="relative mx-auto" style={{ width: totalW, height: totalH }}>
        <svg aria-hidden className="absolute inset-0" width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`}>
          {layout.connectors.map((c, i) => {
            const isFinal = c.col === layout.colsPerSide;
            const fromCol = c.col - 1;
            const fx = c.side === "L" ? fromCol * COL_W + NODE_W : (2 * layout.colsPerSide - fromCol) * COL_W + (COL_W - NODE_W);
            const fy = rowCenter(fromCol, c.fromRow) * SLOT_H;
            const tx = isFinal
              ? colX("center", layout.colsPerSide) + (c.side === "L" ? 0 : NODE_W)
              : c.side === "L" ? c.col * COL_W : (2 * layout.colsPerSide - c.col) * COL_W + COL_W;
            const ty = isFinal ? (rowsPerSide * SLOT_H) / 2 : rowCenter(c.col, c.toRow) * SLOT_H;
            const midX = (fx + tx) / 2;
            return <path key={i} d={`M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />;
          })}
        </svg>
        {layout.nodes.map((node) => {
          const f = byId.get(node.fixtureId);
          if (!f) return null;
          const live = f.status === "in_play";
          return (
            <div
              key={node.fixtureId}
              data-side={node.side}
              className={`absolute rounded-lg px-4 py-2 ring-1 ring-inset ring-white/10 ${live ? "bg-white/[0.12]" : "bg-white/[0.05]"}`}
              style={{ left: colX(node.side, node.col), top: nodeTop(node.side, node.col, node.row), width: NODE_W, height: NODE_H }}
            >
              <div className="flex h-full flex-col justify-center gap-0.5 font-display text-xl font-semibold leading-tight">
                <span className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{f.home ?? "TBD"}</span>
                  {live && <span className="animate-live-pulse h-2 w-2 shrink-0 rounded-full bg-emerald-400" />}
                </span>
                <span className="flex items-center justify-between gap-2 text-white/80">
                  <span className="min-w-0 truncate">{f.away ?? "TBD"}</span>
                  {f.line !== null && (
                    <span className="shrink-0 font-bold tabular-nums text-accent-line">{f.line}</span>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Stepladder on the big screen: summit at the top, climbers below.
function LadderSlide({ fixtures }: { fixtures: BracketSlideFixture[] }) {
  const rungs = [...fixtures].sort((a, b) => b.round_no - a.round_no);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      {rungs.map((f, i) => {
        const live = f.status === "in_play";
        return (
          <div key={f.id}>
            <p className="mb-1 font-display text-sm font-semibold uppercase tracking-[0.18em] text-white/50">
              {i === 0 ? "Final" : `Rung ${rungs.length - i}`}
            </p>
            <div className={`rounded-lg px-5 py-3 ring-1 ring-inset ring-white/10 ${live ? "bg-white/[0.12]" : "bg-white/[0.05]"}`}>
              <div className="flex flex-col gap-1 font-display text-2xl font-semibold leading-tight">
                <span className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">{f.home ?? "TBD"}</span>
                  {live && <span className="animate-live-pulse h-2 w-2 shrink-0 rounded-full bg-emerald-400" />}
                </span>
                <span className="flex items-center justify-between gap-3 text-white/80">
                  <span className="min-w-0 truncate">{f.away ?? "TBD"}</span>
                  {f.line !== null && <span className="shrink-0 font-bold tabular-nums text-accent-line">{f.line}</span>}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Double elimination on the big screen: winners lane over losers lane, grand
// final (+ reset) joining the lane finals — mirrors the console/public math.
function DoubleElimSlide({ fixtures }: { fixtures: BracketSlideFixture[] }) {
  const result = doubleElimBracket(fixtures);
  if (!result.ok) return null;
  const layout = result.layout;
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const COL_W = 232;
  const SLOT_H = 96;
  const NODE_W = COL_W - 22;
  const NODE_H = 66;
  const LANE_GAP = 56;
  const LABEL_H = 28;
  const wbH = Math.max(layout.wbRows, 1) * SLOT_H;
  const lbH = Math.max(layout.lbRows, 0) * SLOT_H;
  const wbTop = LABEL_H;
  const lbTop = wbTop + wbH + LANE_GAP + (lbH > 0 ? LABEL_H : 0);
  const gfX = Math.max(layout.k, layout.lbCols) * COL_W;
  const totalW = gfX + COL_W * (layout.resetId !== undefined ? 2 : 1);
  const totalH = lbTop + lbH;
  const wbY = (col: number, row: number) => wbTop + rowCenter(col, row) * SLOT_H;
  const lbY = (col: number, row: number) => lbTop + rowCenter(lbRowUnit(col), row) * SLOT_H;
  const gfY = (wbTop + (lbH > 0 ? lbTop + lbH : wbTop + wbH)) / 2;
  const label = "absolute font-display text-sm font-semibold uppercase tracking-[0.18em] text-white/50";
  const node = (f: BracketSlideFixture, left: number, top: number) => {
    const live = f.status === "in_play";
    return (
      <div
        key={f.id}
        className={`absolute rounded-lg px-4 py-2 ring-1 ring-inset ring-white/10 ${live ? "bg-white/[0.12]" : "bg-white/[0.05]"}`}
        style={{ left, top, width: NODE_W, height: NODE_H }}
      >
        <div className="flex h-full flex-col justify-center gap-0.5 font-display text-xl font-semibold leading-tight">
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate">{f.home ?? "TBD"}</span>
            {live && <span className="animate-live-pulse h-2 w-2 shrink-0 rounded-full bg-emerald-400" />}
          </span>
          <span className="flex items-center justify-between gap-2 text-white/80">
            <span className="min-w-0 truncate">{f.away ?? "TBD"}</span>
            {f.line !== null && <span className="shrink-0 font-bold tabular-nums text-accent-line">{f.line}</span>}
          </span>
        </div>
      </div>
    );
  };
  return (
    <div className="overflow-x-auto">
      <div className="relative mx-auto" style={{ width: totalW, height: totalH }}>
        <span className={label} style={{ left: 0, top: 0 }}>Winners bracket</span>
        {lbH > 0 && <span className={label} style={{ left: 0, top: wbTop + wbH + LANE_GAP }}>Losers bracket</span>}
        <svg aria-hidden className="absolute inset-0" width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`}>
          {layout.connectors.map((c, i) => {
            const y = c.lane === "WB" ? wbY : lbY;
            const fx = (c.col - 1) * COL_W + NODE_W;
            const tx = c.col * COL_W;
            const fy = y(c.col - 1, c.fromRow);
            const ty = y(c.col, c.toRow);
            const midX = (fx + tx) / 2;
            return <path key={i} d={`M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />;
          })}
          <path d={`M ${(layout.k - 1) * COL_W + NODE_W} ${wbY(layout.k - 1, 0)} H ${gfX - 12} V ${gfY} H ${gfX}`} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />
          {layout.lbCols > 0 && (
            <path d={`M ${(layout.lbCols - 1) * COL_W + NODE_W} ${lbY(layout.lbCols - 1, 0)} H ${gfX - 12} V ${gfY} H ${gfX}`} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />
          )}
        </svg>
        {layout.nodes.map((n) => {
          const f = byId.get(n.fixtureId);
          if (!f) return null;
          const top = n.lane === "WB" ? wbY(n.col, n.row) - NODE_H / 2 : n.lane === "LB" ? lbY(n.col, n.row) - NODE_H / 2 : gfY - NODE_H / 2;
          const left = n.lane === "GF" ? gfX + n.col * COL_W : n.col * COL_W;
          return (
            <span key={n.fixtureId} data-lane={n.lane} className="contents">
              {n.lane === "GF" && (
                <span className={label} style={{ left, top: top - LABEL_H + 6 }}>
                  {n.col === 0 ? "Grand final" : "Reset"}
                </span>
              )}
              {node(f, left, top)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// Page playoffs (IPL) on the big screen — same card as console/public/poster.
function PagePlayoffSlide({ fixtures }: { fixtures: BracketSlideFixture[] }) {
  const result = pagePlayoffBracket(fixtures);
  if (!result.ok) return null;
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const COL_W = 300;
  const NODE_W = COL_W - 28;
  const NODE_H = 72;
  const LABEL_H = 26;
  const pos: Record<string, { x: number; y: number }> = {
    q1: { x: 0, y: LABEL_H },
    eliminator: { x: 0, y: LABEL_H + 210 },
    q2: { x: COL_W, y: LABEL_H + 132 },
    final: { x: 2 * COL_W, y: LABEL_H + 62 },
  };
  const LABELS: Record<string, string> = { q1: "Qualifier 1", eliminator: "Eliminator", q2: "Qualifier 2", final: "Final" };
  const totalW = 2 * COL_W + NODE_W;
  const totalH = LABEL_H + 210 + NODE_H + 10;
  const cy = (slot: string) => pos[slot]!.y + NODE_H / 2;
  const rxx = (slot: string) => pos[slot]!.x + NODE_W;
  return (
    <div className="overflow-x-auto">
      <div className="relative mx-auto" style={{ width: totalW, height: totalH }}>
        <svg aria-hidden className="absolute inset-0" width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`}>
          <path d={`M ${rxx("q1")} ${cy("q1")} H ${(rxx("q1") + pos.q2!.x) / 2} V ${cy("q2")} H ${pos.q2!.x}`} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" strokeDasharray="5 4" />
          <path d={`M ${rxx("eliminator")} ${cy("eliminator")} H ${(rxx("eliminator") + pos.q2!.x) / 2} V ${cy("q2")} H ${pos.q2!.x}`} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />
          <path d={`M ${rxx("q1")} ${cy("q1")} H ${(rxx("q1") + pos.final!.x) / 2 + 44} V ${cy("final")} H ${pos.final!.x}`} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />
          <path d={`M ${rxx("q2")} ${cy("q2")} H ${(rxx("q2") + pos.final!.x) / 2} V ${cy("final")} H ${pos.final!.x}`} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="2" />
        </svg>
        {result.layout.nodes.map((n) => {
          const f = byId.get(n.fixtureId);
          if (!f) return null;
          const p = pos[n.slot]!;
          const live = f.status === "in_play";
          return (
            <span key={n.fixtureId} data-slot={n.slot} className="contents">
              <span className="absolute font-display text-sm font-semibold uppercase tracking-[0.18em] text-white/50" style={{ left: p.x, top: p.y - LABEL_H + 4 }}>
                {LABELS[n.slot]}
              </span>
              <div className={`absolute rounded-lg px-4 py-2 ring-1 ring-inset ring-white/10 ${live ? "bg-white/[0.12]" : "bg-white/[0.05]"}`} style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}>
                <div className="flex h-full flex-col justify-center gap-0.5 font-display text-xl font-semibold leading-tight">
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{f.home ?? "TBD"}</span>
                    {live && <span className="animate-live-pulse h-2 w-2 shrink-0 rounded-full bg-emerald-400" />}
                  </span>
                  <span className="flex items-center justify-between gap-2 text-white/80">
                    <span className="min-w-0 truncate">{f.away ?? "TBD"}</span>
                    {f.line !== null && <span className="shrink-0 font-bold tabular-nums text-accent-line">{f.line}</span>}
                  </span>
                </div>
              </div>
            </span>
          );
        })}
      </div>
    </div>
  );
}
