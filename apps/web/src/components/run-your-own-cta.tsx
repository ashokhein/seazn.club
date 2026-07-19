"use client";
import Link from "next/link";
import { EVENTS, track } from "@/lib/analytics";

/** Player→organiser loop (PLG L2): nudges an engaged player on /me to start
 *  their own competition. Copy is passed in so the page localizes it. */
export function RunYourOwnCta({ label, cta }: { label: string; cta: string }) {
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-4 py-1.5">
      <p className="text-xs font-medium text-slate-600">{label}</p>
      <Link
        href="/start?utm_source=me&utm_medium=player&utm_campaign=plg"
        onClick={() => track(EVENTS.PLAYER_STARTED_OWN_ORG, { from: "me" })}
        className="btn btn-primary min-h-11 px-3 text-xs"
      >
        {cta}
      </Link>
    </div>
  );
}
