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
 *  everywhere. Grassroots sport runs on WhatsApp. */
export function ShareBar({ path, title }: { path: string; title: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const { url, wa } = shareLinks(origin, path, title);

  async function native() {
    track(EVENTS.SHARE_FIRED, { channel: "native" });
    try {
      await navigator.share?.({ title, url });
    } catch {
      /* dismissed */
    }
  }
  async function copy() {
    track(EVENTS.SHARE_FIRED, { channel: "copy" });
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
      {typeof navigator !== "undefined" && "share" in navigator && (
        <button type="button" onClick={native} className="btn btn-ghost">
          Share
        </button>
      )}
      <a
        href={wa}
        target="_blank"
        rel="noreferrer"
        onClick={() => track(EVENTS.SHARE_FIRED, { channel: "whatsapp" })}
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
