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
        className={`flex items-center rounded-md px-2 py-1.5 transition-colors hover:bg-slate-100 hover:text-slate-900 ${
          open ? "bg-slate-100 text-slate-900" : "text-slate-600"
        }`}
      >
        <CircleHelp className="h-4 w-4" strokeWidth={1.75} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 text-sm shadow-lg"
        >
          {ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-slate-700 hover:bg-purple-50"
            >
              {item.label}
            </Link>
          ))}
          <a
            href="mailto:support@seazn.club"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-2 text-slate-700 hover:bg-purple-50"
          >
            Contact support
          </a>
        </div>
      )}
    </div>
  );
}
