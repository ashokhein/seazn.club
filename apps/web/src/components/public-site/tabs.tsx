"use client";
// Minimal tab switcher for the division home (Schedule / Standings /
// Entrants — doc 09 §2). All panels are server-rendered and shipped in the
// ISR payload; this only toggles visibility (fast + crawlable).
import { useState, type ReactNode } from "react";

interface Props {
  labels: string[];
  children: ReactNode[]; // one panel per label, same order
}

export function Tabs({ labels, children }: Props) {
  const [active, setActive] = useState(0);
  return (
    <div>
      <div role="tablist" className="mb-4 flex gap-1 border-b border-zinc-200">
        {labels.map((label, i) => (
          <button
            key={label}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className={
              i === active
                ? "border-b-2 border-zinc-900 px-3 py-2 text-sm font-medium text-zinc-900"
                : "px-3 py-2 text-sm text-zinc-500 hover:text-zinc-800"
            }
          >
            {label}
          </button>
        ))}
      </div>
      {children.map((panel, i) => (
        <div key={labels[i]} role="tabpanel" hidden={i !== active}>
          {panel}
        </div>
      ))}
    </div>
  );
}
