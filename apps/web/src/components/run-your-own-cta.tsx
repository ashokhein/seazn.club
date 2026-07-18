"use client";
import Link from "next/link";
import { EVENTS, track } from "@/lib/analytics";

/** Player→organiser loop (PLG L2): nudges an engaged player on /me to start
 *  their own competition. Copy is passed in so the page localizes it. */
export function RunYourOwnCta({ label, cta }: { label: string; cta: string }) {
  return (
    <div className="card mt-6 flex flex-col gap-2 p-6 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-sm font-medium">{label}</p>
      <Link
        href="/start?utm_source=me&utm_medium=player&utm_campaign=plg"
        onClick={() => track(EVENTS.PLAYER_STARTED_OWN_ORG, { from: "me" })}
        className="btn btn-primary text-sm"
      >
        {cta}
      </Link>
    </div>
  );
}
