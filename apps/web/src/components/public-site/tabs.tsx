"use client";
// Minimal tab switcher for the division home (Schedule / Standings /
// Entrants — doc 09 §2). All panels are server-rendered and shipped in the
// ISR payload; this only toggles visibility (fast + crawlable).
// Styled as a segmented pill bar, sticky under the court masthead so a
// spectator can hop tabs from anywhere in a long schedule.
import { useState, type ReactNode } from "react";

interface Props {
  labels: string[];
  children: ReactNode[]; // one panel per label, same order
}

export function Tabs({ labels, children }: Props) {
  const [active, setActive] = useState(0);
  return (
    <div>
      <div className="sticky top-[54px] z-30 -mx-4 mb-5 bg-canvas/90 px-4 py-2 backdrop-blur">
        <div
          role="tablist"
          className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full border border-zinc-200/80 bg-surface p-1 shadow-sm"
        >
          {labels.map((label, i) => (
            <button
              key={label}
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={
                i === active
                  ? "shrink-0 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink shadow-sm"
                  : "shrink-0 rounded-full px-4 py-1.5 text-sm font-medium text-ink-muted transition hover:bg-accent-soft hover:text-accent-strong"
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {children.map((panel, i) => (
        <div key={labels[i]} role="tabpanel" hidden={i !== active}>
          {panel}
        </div>
      ))}
    </div>
  );
}
