"use client";

// SPEC-1 soft warning (D8: never blocks). When an event on the pad is
// attributed to a player with an active suspension in this division, show a
// night-background, one-sentence, dismissible banner with the card glyph. It
// must read at a glance mid-match on mobile — no icon soup.
import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { CardGlyph } from "./card-glyph";

export function PadSuspensionBanner({
  name,
  served,
  total,
}: {
  name: string;
  served: number;
  total: number;
}) {
  const msg = useMsg();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div
      role="status"
      data-testid="pad-suspension-banner"
      className="flex items-center gap-3 rounded-lg bg-slate-900 px-4 py-3 text-sm text-cream"
    >
      <CardGlyph tone="red" />
      <p className="min-w-0 flex-1">{msg("disc.pad.banner", { name, served, total })}</p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={msg("disc.pad.dismiss")}
        className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-cream/60 hover:text-cream"
      >
        ✕
      </button>
    </div>
  );
}
