"use client";

// One-tap share (v3/10 #2): the Web Share API where it exists (mobile —
// lands straight in WhatsApp's share sheet), wa.me with the pre-written
// message as the fallback (desktop). WhatsApp is where amateur sport lives;
// the message is composed by the caller so each surface reads naturally.
import { useState } from "react";
import { Share2 } from "lucide-react";
import { msg } from "@/lib/messages";

export function ShareButton({
  text,
  url,
  title,
  className = "",
  compact = false,
}: {
  /** Pre-written message, WITHOUT the link (appended automatically). */
  text: string;
  url: string;
  title?: string;
  className?: string;
  /** Icon-only variant for tight rows. */
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function share() {
    const absolute = url.startsWith("http")
      ? url
      : `${window.location.origin}${url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url: absolute });
        return;
      } catch {
        // dismissed the sheet — fall through to nothing
        return;
      }
    }
    // Desktop fallback: WhatsApp Web with the message + link prefilled.
    const wa = `https://wa.me/?text=${encodeURIComponent(`${text}\n${absolute}`)}`;
    window.open(wa, "_blank", "noopener");
    try {
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard is a nicety */
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      aria-label={msg("share.whatsapp")}
      className={
        className ||
        "inline-flex items-center gap-1.5 rounded-lg border border-zinc-200/80 bg-surface px-3 py-1.5 text-sm font-medium text-accent-strong shadow-sm transition hover:bg-accent-soft"
      }
    >
      <Share2 className="h-4 w-4" strokeWidth={1.75} />
      {compact ? null : copied ? msg("share.copied") : msg("share.whatsapp")}
    </button>
  );
}
