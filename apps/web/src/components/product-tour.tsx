"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";

interface TourStep {
  id: string;
  /** Route this step lives on — advancing across routes navigates there. */
  path: string;
  /** Matches an element's data-tour attribute; null renders a centered card. */
  target: string | null;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  {
    id: "welcome",
    path: "/dashboard",
    target: null,
    title: "Welcome to Seazn Club 👋",
    body: "A quick tour of the essentials — your organisation, settings and creating your first competition. Takes under a minute.",
  },
  {
    id: "org-chip",
    path: "/dashboard",
    target: "org-chip",
    title: "Your organisation",
    body: "Everything you create lives under this organisation. Next, let's see where you can rename it.",
  },
  {
    id: "org-rename",
    path: "/settings",
    target: "org-rename",
    title: "Rename your organisation",
    body: "Type a new name here and save. The tabs on the left also cover your team, plan and API keys.",
  },
  {
    id: "new-competition",
    path: "/dashboard",
    target: "new-competition",
    title: "Create a competition",
    body: "A competition holds one or more divisions — each with its own sport, entrants and format. Let's start one.",
  },
  {
    id: "wizard",
    path: "/competitions/new",
    target: "competition-wizard",
    title: "Your first competition",
    body: "Follow the wizard: name it, add a division, pick a sport and format. Replay this tour anytime from Settings → Organisation.",
  },
];

export const TOUR_STORAGE_KEY = "seazn.tour.step";
const PADDING = 8;
const TOOLTIP_WIDTH = 320;

type Rect = { top: number; left: number; width: number; height: number };

function measure(target: string): Rect | null {
  const el = document.querySelector(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function ProductTour({ autoStart }: { autoStart: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [step, setStep] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Resume a tour in progress (after cross-page navigation) or auto-start on
  // the dashboard for users who haven't completed it yet.
  useEffect(() => {
    const stored = sessionStorage.getItem(TOUR_STORAGE_KEY);
    if (stored !== null) {
      const i = Number(stored);
      if (Number.isInteger(i) && STEPS[i]?.path === pathname) {
        setStep(i);
      } else if (!Number.isInteger(i) || !STEPS[i]) {
        sessionStorage.removeItem(TOUR_STORAGE_KEY);
      }
      // Path mismatch: keep the key — the navigation we triggered may still
      // be in flight; the component on the destination page resumes it.
      return;
    }
    if (autoStart && pathname === "/dashboard") {
      sessionStorage.setItem(TOUR_STORAGE_KEY, "0");
      setStep(0);
    }
  }, [autoStart, pathname]);

  const finish = useCallback((markDone: boolean) => {
    sessionStorage.removeItem(TOUR_STORAGE_KEY);
    setStep(null);
    if (markDone) fetch("/api/tour", { method: "POST" }).catch(() => {});
  }, []);

  const goTo = useCallback(
    (i: number) => {
      if (i >= STEPS.length) {
        finish(true);
        return;
      }
      if (i < 0) return;
      sessionStorage.setItem(TOUR_STORAGE_KEY, String(i));
      if (STEPS[i].path !== pathname) {
        setStep(null); // hide until the destination page's tour resumes
        router.push(STEPS[i].path);
      } else {
        setStep(i);
      }
    },
    [pathname, router, finish],
  );

  // Track the highlighted element's position; poll briefly in case it renders
  // after navigation, then follow resize/scroll.
  useEffect(() => {
    if (step === null) return;
    const target = STEPS[step].target;
    if (!target) {
      setRect(null);
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let scrolled = false;

    const update = () => {
      if (cancelled) return;
      const r = measure(target);
      if (r) {
        if (!scrolled) {
          scrolled = true;
          document
            .querySelector(`[data-tour="${target}"]`)
            ?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
          setRect(measure(target));
        } else {
          setRect(r);
        }
      } else if (attempts++ < 20) {
        setTimeout(update, 50);
      } else {
        setRect(null); // target missing (e.g. hidden on mobile) — centered card
      }
    };
    update();

    const follow = () => {
      if (!cancelled && scrolled) setRect(measure(target));
    };
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [step]);

  // Escape skips the tour.
  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, finish]);

  if (!mounted || step === null) return null;
  const s = STEPS[step];
  const isLast = step === STEPS.length - 1;

  // Tooltip placement: below the target when there's room, otherwise above;
  // centered card when there's no target.
  let tooltipStyle: React.CSSProperties;
  if (rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(rect.left, 16), Math.max(vw - TOOLTIP_WIDTH - 16, 16));
    const below = rect.top + rect.height + PADDING + 220 < vh;
    tooltipStyle = below
      ? { top: rect.top + rect.height + PADDING + 8, left }
      : { bottom: vh - rect.top + PADDING + 8, left };
  } else {
    tooltipStyle = { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label="Product tour">
      {/* Dim layer — spotlight cut-out around the target via box-shadow */}
      {rect ? (
        <div
          className="pointer-events-none fixed rounded-xl ring-2 ring-purple-400 transition-all duration-300"
          style={{
            top: rect.top - PADDING,
            left: rect.left - PADDING,
            width: rect.width + PADDING * 2,
            height: rect.height + PADDING * 2,
            boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.55)",
          }}
        />
      ) : (
        <div className="fixed inset-0 bg-slate-900/55" />
      )}

      {/* Tooltip */}
      <div
        className="fixed rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
        style={{ width: TOOLTIP_WIDTH, ...tooltipStyle }}
      >
        <h3 className="text-sm font-semibold text-slate-800">{s.title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{s.body}</p>

        <div className="mt-4 flex items-center gap-1.5">
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-4 bg-purple-500" : "w-1.5 bg-slate-200"
              }`}
            />
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => finish(true)}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button type="button" onClick={() => goTo(step - 1)} className="btn btn-ghost text-xs">
                Back
              </button>
            )}
            <button type="button" onClick={() => goTo(step + 1)} className="btn btn-primary text-xs">
              {isLast ? "Finish" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
