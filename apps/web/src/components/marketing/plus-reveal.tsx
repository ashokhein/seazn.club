"use client";

import { useState, type ReactNode } from "react";
import { track } from "@/lib/analytics";
import { EVENTS } from "@/lib/analytics-events";

/**
 * Progressive disclosure for the Pro Plus offer (spec §4): the hero grid
 * stays 3-up; this teaser sits below it and swaps itself for the
 * server-rendered Pro Plus card (passed as children) on click. State starts
 * hidden on server AND client — no hydration mismatch.
 */
export function PlusReveal({
  teaser,
  cta,
  children,
}: {
  teaser: string;
  cta: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (open) return <div data-plus-revealed>{children}</div>;
  return (
    <div className="card mx-auto flex max-w-2xl flex-col items-center gap-3 p-6 text-center sm:flex-row sm:justify-between sm:text-left">
      <p className="text-sm text-slate-600">{teaser}</p>
      <button
        type="button"
        data-plus-reveal-cta
        className="btn btn-ghost shrink-0 border-indigo-300 text-indigo-700 hover:bg-indigo-50"
        onClick={() => {
          track(EVENTS.PRICING_PLUS_REVEALED, {});
          setOpen(true);
        }}
      >
        {cta}
      </button>
    </div>
  );
}
