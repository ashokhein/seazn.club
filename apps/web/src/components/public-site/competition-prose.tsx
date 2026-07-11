// The organiser-prose renderer (v3/06 §2) — used by the public pages AND the
// editor's Preview tab, so what organisers preview is exactly what visitors
// get. Input is the sanitized HTML from lib/prose renderProse (never raw
// user HTML). Styling keys off .competition-prose in globals.css — courtside
// type ramp, accent-aware links, and the .prose-cta sponsor button.
export function CompetitionProse({ html, className = "" }: { html: string; className?: string }) {
  if (!html) return null;
  return (
    <div
      className={`competition-prose ${className}`}
      // Safe by construction: renderProse sanitizes with an element allowlist.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
