"use client";

// The console "?" menu (v3/06 §3). A real popover, not <details>: closes on
// outside click, Escape, and after choosing an item — same dismissal pattern
// as <Tip>.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CircleHelp } from "lucide-react";

const ITEMS = [
  { href: "/help", label: "Help centre" },
  { href: "/developers", label: "Developer docs" },
] as const;

export function HelpMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Help"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center rounded-md px-2 py-1.5 transition-colors hover:bg-cream/10 hover:text-cream ${
          open ? "bg-cream/10 text-cream" : "text-cream/70"
        }`}
      >
        <CircleHelp className="h-4 w-4" strokeWidth={1.75} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 w-48 overflow-hidden rounded-xl border border-cream/10 bg-night-2 py-1 text-sm shadow-xl"
        >
          {ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-cream/85 hover:bg-cream/10 hover:text-cream"
            >
              {item.label}
            </Link>
          ))}
          <a
            href="mailto:support@seazn.club"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-cream/85 hover:bg-cream/10 hover:text-cream"
          >
            Contact support
          </a>
        </div>
      )}
    </div>
  );
}
