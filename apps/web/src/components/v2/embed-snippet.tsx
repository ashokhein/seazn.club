"use client";

// Embed copy-snippet UI (v3/10 #4) — the division sharing surface. Pro-gated:
// free orgs see the UpgradeGate; Pro orgs pick a widget and copy one iframe
// plus the auto-height listener. The widget honours visibility on its own.
import { useState } from "react";
import { Check, Code2, Copy } from "lucide-react";
import { UpgradeGate } from "@/components/upgrade-gate";
import { msg } from "@/lib/messages";

const WIDGETS = [
  { key: "standings", label: "Standings" },
  { key: "schedule", label: "Schedule" },
  { key: "bracket", label: "Bracket" },
] as const;

function snippetFor(divisionId: string, widget: string): string {
  return `<iframe src="https://seazn.club/embed/divisions/${divisionId}/${widget}"
        style="width:100%;border:0" loading="lazy"
        title="Live ${widget} — seazn.club"></iframe>
<script>
  addEventListener("message", (e) => {
    if (e.data && e.data.type === "seazn:embed:height") {
      for (const f of document.querySelectorAll("iframe[src*='seazn.club/embed']"))
        if (f.contentWindow === e.source) f.style.height = e.data.height + "px";
    }
  });
</script>`;
}

export function EmbedSnippet({
  divisionId,
  entitled,
}: {
  divisionId: string;
  entitled: boolean;
}) {
  const [widget, setWidget] = useState<string>("standings");
  const [copied, setCopied] = useState(false);

  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
        <Code2 className="h-4 w-4 text-purple-500" strokeWidth={1.75} />
        {msg("embed.title")}
      </h2>
      <p className="mt-1 text-xs text-slate-500">{msg("embed.line")}</p>

      {!entitled ? (
        <div className="mt-3">
          <UpgradeGate feature="embeds.enabled" compact />
        </div>
      ) : (
        <>
          <div className="mt-3 flex gap-1.5" role="tablist" aria-label="Widget">
            {WIDGETS.map((w) => (
              <button
                key={w.key}
                type="button"
                role="tab"
                aria-selected={widget === w.key}
                onClick={() => {
                  setWidget(w.key);
                  setCopied(false);
                }}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  widget === w.key
                    ? "bg-purple-100 text-purple-800"
                    : "text-slate-500 hover:bg-purple-50 hover:text-purple-700"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>
          <div className="relative mt-2">
            <textarea
              readOnly
              rows={7}
              value={snippetFor(divisionId, widget)}
              onFocus={(e) => e.target.select()}
              className="w-full rounded-lg border border-purple-100 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100"
              aria-label="Embed snippet"
            />
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(snippetFor(divisionId, widget));
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="btn btn-ghost absolute right-2 top-2 bg-white/95 px-2.5 py-1 text-xs"
            >
              {copied ? (
                <>
                  <Check className="mr-1 h-3.5 w-3.5 text-green-600" /> Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-3.5 w-3.5" /> {msg("embed.copy")}
                </>
              )}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
