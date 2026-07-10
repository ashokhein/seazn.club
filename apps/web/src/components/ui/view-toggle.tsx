"use client";

// Cards ⇄ compact list toggle (v3/03 §2, for orgs with >20 comps). The grid
// itself is server-rendered; this wrapper only flips a data attribute the
// .ecard styles respond to, and remembers the choice per browser.
import { useEffect, useState, type ReactNode } from "react";
import { LayoutGrid, Rows3 } from "lucide-react";
import { msg } from "@/lib/messages";

type View = "cards" | "list";

export function ViewToggleContainer({
  storageKey,
  toggle,
  children,
}: {
  storageKey: string;
  /** Show the toggle control at all (hidden for short lists). */
  toggle: boolean;
  children: ReactNode;
}) {
  const [view, setView] = useState<View>("cards");

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "list" || saved === "cards") setView(saved);
  }, [storageKey]);

  function pick(next: View) {
    setView(next);
    window.localStorage.setItem(storageKey, next);
  }

  return (
    <div data-view={view}>
      {toggle && (
        <div className="mb-3 flex justify-end">
          <div role="group" aria-label="View" className="flex rounded-lg border border-purple-100 bg-white p-0.5">
            {(
              [
                { v: "cards" as const, label: msg("card.view.cards"), Icon: LayoutGrid },
                { v: "list" as const, label: msg("card.view.list"), Icon: Rows3 },
              ]
            ).map(({ v, label, Icon }) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => pick(v)}
                className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  view === v ? "bg-purple-100 text-purple-800" : "text-slate-500 hover:text-purple-700"
                }`}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={2} />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className={view === "list" ? "ecard-list space-y-2" : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3"}>
        {children}
      </div>
    </div>
  );
}
