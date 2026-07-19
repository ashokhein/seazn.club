"use client";
// "Download image card" (SPEC-2): the 1080×1350 story PNG the organiser posts to
// social themselves — the OAuth-free "auto-post" replacement. Fires
// post_card_downloaded (PLG loop). Stable route path (story.png is not hashed),
// so the href is built directly.
import { track, EVENTS } from "@/lib/analytics";

export function DownloadCardButton({
  href,
  kind,
  label,
}: {
  href: string;
  kind: string;
  label: string;
}) {
  return (
    <a
      href={href}
      download
      data-testid="news-download-card"
      onClick={() => track(EVENTS.POST_CARD_DOWNLOADED, { kind })}
      className="btn btn-ghost text-xs"
    >
      {label}
    </a>
  );
}
