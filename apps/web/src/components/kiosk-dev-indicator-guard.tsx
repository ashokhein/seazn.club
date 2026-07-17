"use client";

import { useEffect } from "react";

/**
 * TV/noticeboard slideshow routes (`/slideshow/*`) render unattended on a
 * kiosk display with nobody there to click or dismiss anything — so unlike
 * every other route (where the fix was just repositioning it, see
 * next.config.js `devIndicators.position`), the dev-mode route indicator
 * needs to not render here at all: it was obscuring the slide counter
 * (design/fix-ui audit, 04-account-public-embed.md, "TV slideshow/
 * noticeboard view also shows the floating help FAB, obscuring the slide
 * counter").
 *
 * It's dev-only (Next never ships it in a production build — see
 * node_modules/next/dist/docs/.../devIndicators.md) and there's no
 * per-route `devIndicators` config, so this removes it defensively at the
 * DOM level for local dev/staging preview of the kiosk view: an actual
 * `.remove()`, not a CSS `display: none`, because a hidden-but-present
 * element isn't "suppressed entirely". The indicator mounts asynchronously
 * (and can remount across client-side route changes within /slideshow),
 * so a MutationObserver keeps removing it for as long as this route is
 * mounted rather than a one-shot check on first paint.
 */
export function KioskDevIndicatorGuard() {
  useEffect(() => {
    const removeIndicator = () => {
      document.querySelectorAll("nextjs-portal").forEach((el) => el.remove());
    };
    removeIndicator();
    const observer = new MutationObserver(removeIndicator);
    observer.observe(document.body, { childList: true, subtree: false });
    return () => observer.disconnect();
  }, []);

  return null;
}
