"use client";

// Tips framework (v3/03 §4): <Tip id> renders an inline ⓘ whose popover
// explains one concept in 1–3 sentences; <TipCallout id> is the dismissible
// first-run banner variant (dismissal remembered per browser). All copy
// comes from config/tips.ts; "Learn more →" renders only when the /help
// article actually resolves (PROMPT-35) — never a dead link.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Info, X } from "lucide-react";
import { TIPS, type TipId } from "@/config/tips";
import { helpUrl } from "@/lib/help";

export function Tip({ id, className = "" }: { id: TipId; className?: string }) {
  const { title, body, helpSlug } = TIPS[id];
  const href = helpUrl(helpSlug);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`About: ${title}`}
        onClick={() => setOpen((v) => !v)}
        className="grid h-5 w-5 place-items-center rounded-full text-slate-400 transition hover:text-purple-600"
      >
        <Info className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
      {open && (
        <span
          role="note"
          className="absolute left-1/2 top-7 z-30 w-64 -translate-x-1/2 rounded-xl border border-purple-100 bg-white p-3 text-left shadow-lg"
        >
          <span className="block text-xs font-semibold text-slate-800">{title}</span>
          <span className="mt-1 block text-xs leading-relaxed text-slate-600">{body}</span>
          {href && (
            <Link href={href} className="mt-2 block text-xs font-medium text-purple-600 hover:underline">
              Learn more →
            </Link>
          )}
        </span>
      )}
    </span>
  );
}

export function TipCallout({ id, className = "" }: { id: TipId; className?: string }) {
  const { title, body, helpSlug } = TIPS[id];
  const href = helpUrl(helpSlug);
  const storageKey = `seazn.tip.${id}`;
  // Start hidden; show after the dismissed check so a dismissed callout
  // never flashes.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (window.localStorage.getItem(storageKey) !== "1") setVisible(true);
  }, [storageKey]);

  if (!visible) return null;

  return (
    <div
      role="note"
      className={`flex items-start gap-3 rounded-xl border border-purple-100 bg-purple-50/60 px-4 py-3 ${className}`}
    >
      <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-purple-500" strokeWidth={2} />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-purple-900">{title}</p>
        <p className="mt-0.5 text-purple-800/80">{body}</p>
        {href && (
          <Link href={href} className="mt-1 inline-block text-xs font-medium text-purple-700 hover:underline">
            Learn more →
          </Link>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss tip"
        onClick={() => {
          window.localStorage.setItem(storageKey, "1");
          setVisible(false);
        }}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-purple-400 transition hover:bg-purple-100 hover:text-purple-700"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}
