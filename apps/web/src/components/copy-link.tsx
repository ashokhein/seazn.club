"use client";

import { useEffect, useState } from "react";

/** Shows an absolute share URL (origin + path) with a one-click copy button. */
export function CopyLink({ path }: { path: string }) {
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const url = origin ? `${origin}${path}` : path;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the field is selectable as a fallback */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        readOnly
        value={url}
        onFocus={(e) => e.currentTarget.select()}
        className="min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-600"
      />
      <button type="button" onClick={copy} className="btn btn-ghost text-xs">
        {copied ? "Copied ✓" : "Copy"}
      </button>
      <a href={path} target="_blank" rel="noopener" className="btn btn-ghost text-xs">
        Open ↗
      </a>
    </div>
  );
}
