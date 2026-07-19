"use client";
import Link from "next/link";
import { EVENTS, track } from "@/lib/analytics";

/** Player→organiser loop (PLG L2): nudges an engaged player on /me to start
 *  their own competition. Copy is passed in so the page localizes it. Night
 *  ribbon (user-picked direction B, 2026-07-19): a w-fit stadium-night bar —
 *  it must NOT stretch the content column. Callers gate it to users with no
 *  org; organisers never see their own acquisition pitch. */
export function RunYourOwnCta({ label, cta }: { label: string; cta: string }) {
  return (
    <div
      data-testid="run-your-own"
      className="mt-6 flex w-fit max-w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-md bg-slate-900 px-4 py-2"
    >
      <p className="text-xs font-medium text-slate-300">{label}</p>
      <Link
        href="/start?utm_source=me&utm_medium=player&utm_campaign=plg"
        onClick={() => track(EVENTS.PLAYER_STARTED_OWN_ORG, { from: "me" })}
        className="inline-flex min-h-11 items-center text-xs font-semibold uppercase tracking-wide text-lime-400 hover:text-lime-300"
      >
        {cta}
      </Link>
    </div>
  );
}
