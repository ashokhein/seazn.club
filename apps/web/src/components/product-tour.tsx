"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { routes } from "@/lib/routes";

interface TourStep {
  id: string;
  /** Route this step lives on — advancing across routes navigates there.
   *  Console routes are org-scoped (PROMPT-30), so paths build from the
   *  active org slug. */
  path: (org: string) => string;
  /** Matches an element's data-tour attribute; null renders a centered card. */
  target: string | null;
}

// Structure only — the step copy (title/body) is localized and comes from the
// `console` dict keyed `tour.<id>.title|body`, passed in by the server parent.
export const STEPS: TourStep[] = [
  { id: "welcome", path: (org: string) => routes.orgHome(org), target: null },
  { id: "org-chip", path: (org: string) => routes.orgHome(org), target: "org-chip" },
  { id: "org-rename", path: (org: string) => routes.orgSettings(org), target: "org-rename" },
  { id: "connect", path: (org: string) => routes.payments(org), target: "connect-stripe" },
  { id: "billing", path: (org: string) => routes.billing(org), target: "billing-plan" },
  { id: "new-competition", path: (org: string) => routes.orgHome(org), target: "new-competition" },
  { id: "wizard", path: (org: string) => routes.competitionNew(org), target: "competition-wizard" },
];

export const TOUR_STORAGE_KEY = "seazn.tour.step";
const PADDING = 8;
const TOOLTIP_WIDTH = 320;
const TOOLTIP_HEIGHT = 220; // placement estimate; the card itself is auto-height

type Rect = { top: number; left: number; width: number; height: number };

/** Where the tooltip sits relative to the highlighted target: below when it
 *  fits, else above when it fits, else centered. A target taller than the
 *  viewport (a whole settings card on a phone) fits neither side, so it centers
 *  rather than render off-screen. A null rect (no/hidden target) also centers. */
export function placeTooltip(rect: Rect | null, vw: number, vh: number): React.CSSProperties {
  const centered: React.CSSProperties = {
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
  };
  if (!rect) return centered;
  const left = Math.min(Math.max(rect.left, 16), Math.max(vw - TOOLTIP_WIDTH - 16, 16));
  const gap = PADDING + 8;
  const belowTop = rect.top + rect.height + gap;
  if (belowTop + TOOLTIP_HEIGHT <= vh) return { top: belowTop, left };
  if (rect.top - gap - TOOLTIP_HEIGHT >= 0) return { bottom: vh - rect.top + gap, left };
  return centered;
}

function measure(target: string): Rect | null {
  const el = document.querySelector(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** `dict` is the localized `console` tour slice (keys `tour.*`), resolved by the
 *  server parent (Nav) and passed in — client islands can't import the
 *  server-only t(). */
export function ProductTour({
  autoStart,
  orgSlug,
  dict,
}: {
  autoStart: boolean;
  orgSlug: string;
  dict: Record<string, string>;
}) {
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
      if (Number.isInteger(i) && STEPS[i]?.path(orgSlug) === pathname) {
        setStep(i);
      } else if (!Number.isInteger(i) || !STEPS[i]) {
        sessionStorage.removeItem(TOUR_STORAGE_KEY);
      }
      // Path mismatch: keep the key — the navigation we triggered may still
      // be in flight; the component on the destination page resumes it.
      return;
    }
    if (autoStart && pathname === routes.orgHome(orgSlug)) {
      sessionStorage.setItem(TOUR_STORAGE_KEY, "0");
      setStep(0);
    }
  }, [autoStart, pathname, orgSlug]);

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
      if (STEPS[i].path(orgSlug) !== pathname) {
        setStep(null); // hide until the destination page's tour resumes
        router.push(STEPS[i].path(orgSlug));
      } else {
        setStep(i);
      }
    },
    [pathname, router, finish, orgSlug],
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
  const title = dict[`tour.${s.id}.title`] ?? "";
  const body = dict[`tour.${s.id}.body`] ?? "";

  // Tooltip placement: below the target when it fits, else above, else centered
  // (a target taller than the viewport would push the tooltip off-screen).
  const tooltipStyle = placeTooltip(rect, window.innerWidth, window.innerHeight);

  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-label={dict["tour.dialogLabel"]}>
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
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{body}</p>

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
            {dict["tour.skip"]}
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button type="button" onClick={() => goTo(step - 1)} className="btn btn-ghost text-xs">
                {dict["tour.back"]}
              </button>
            )}
            <button type="button" onClick={() => goTo(step + 1)} className="btn btn-primary text-xs">
              {isLast ? dict["tour.finish"] : dict["tour.next"]}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
