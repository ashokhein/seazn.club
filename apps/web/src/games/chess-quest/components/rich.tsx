"use client";

// Renders coach/status copy that carries <strong>/<em> markup. Only our own
// literal strings from content/ and game components flow through here —
// never user input.
export function Rich({ html, className }: { html: string; className?: string }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
