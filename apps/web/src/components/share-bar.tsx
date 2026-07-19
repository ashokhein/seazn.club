"use client";
import { useEffect, useState } from "react";
import { EVENTS, track } from "@/lib/analytics";

/**
 * Pure helper (regression-tested in node env — no window/DOM needed): builds
 * the absolute share URL and the WhatsApp deep-link from an explicit origin.
 */
export function shareLinks(
  origin: string,
  path: string,
  title: string,
): { url: string; wa: string } {
  const url = `${origin}${path}`;
  const wa = `https://wa.me/?text=${encodeURIComponent(`${title} — ${url}`)}`;
  return { url, wa };
}

/** Fan-facing share row (PLG L3): native share on mobile, WhatsApp + copy
 *  everywhere. Grassroots sport runs on WhatsApp. An optional `postShare` adds
 *  news-post context (SPEC-2): each share ALSO fires POST_SHARED{kind,channel}
 *  alongside the generic SHARE_FIRED — the component is reused, not forked. */
export function ShareBar({
  path,
  title,
  postShare,
}: {
  path: string;
  title: string;
  postShare?: { kind: string };
}) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    setOrigin(window.location.origin);
    setCanShare(typeof navigator !== "undefined" && "share" in navigator);
  }, []);
  const { url, wa } = shareLinks(origin, path, title);

  function fire(channel: string) {
    track(EVENTS.SHARE_FIRED, { channel });
    if (postShare) track(EVENTS.POST_SHARED, { channel, kind: postShare.kind });
  }

  async function native() {
    fire("native");
    try {
      await navigator.share?.({ title, url });
    } catch {
      /* dismissed */
    }
  }
  async function copy() {
    fire("copy");
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* blocked */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {canShare && (
        <button
          type="button"
          onClick={native}
          className="btn btn-ghost"
          data-testid="native-share"
        >
          Share
        </button>
      )}
      <a
        href={wa}
        target="_blank"
        rel="noreferrer"
        onClick={() => fire("whatsapp")}
        className="btn btn-ghost"
        aria-label="Share on WhatsApp"
      >
        WhatsApp
      </a>
      <button type="button" onClick={copy} className="btn btn-ghost">
        {copied ? "Copied ✓" : "Copy link"}
      </button>
    </div>
  );
}
