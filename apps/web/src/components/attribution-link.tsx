"use client";
import { EVENTS, track } from "@/lib/analytics";

const START = "https://seazn.club/start";

/** Free-tier attribution turned into an acquisition CTA (PLG L1). Renders the
 *  brand line + a tracked "Run your own free →" link back to /start. */
export function AttributionLink({ surface }: { surface: "badge" | "embed" }) {
  const href = `${START}?utm_source=${surface}&utm_medium=attribution&utm_campaign=plg`;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={() => track(EVENTS.ATTRIBUTION_CLICKED, { surface })}
      className="font-medium underline hover:opacity-80"
    >
      Run your own free →
    </a>
  );
}
