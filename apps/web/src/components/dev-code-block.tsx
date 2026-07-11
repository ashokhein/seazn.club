// Terminal-style code block for /developers guides — server component, no
// highlighter dependency: the accent is the chrome, not token colours.
export function CodeBlock({ title, children }: { title?: string; children: string }) {
  return (
    <figure className="my-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-950 text-slate-100 shadow-sm">
      {title ? (
        <figcaption className="flex items-center gap-2 border-b border-white/10 px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-slate-400">
          <span aria-hidden className="flex gap-1">
            <i className="h-2 w-2 rounded-full bg-slate-600" />
            <i className="h-2 w-2 rounded-full bg-slate-600" />
            <i className="h-2 w-2 rounded-full bg-purple-500" />
          </span>
          {title}
        </figcaption>
      ) : null}
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
        <code>{children.trim()}</code>
      </pre>
    </figure>
  );
}

const SCOPE_STYLE: Record<string, string> = {
  read: "bg-sky-50 text-sky-700 ring-sky-200",
  score: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  manage: "bg-amber-50 text-amber-700 ring-amber-200",
  public: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function ScopeChip({ scope }: { scope: "read" | "score" | "manage" | "public" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 font-mono text-xs font-medium ring-1 ${SCOPE_STYLE[scope]}`}
    >
      {scope}
    </span>
  );
}
