"use client";

// ⋯ overflow menu for EntityCard (v3/03 §1): card actions live here so the
// card body stays one clean click target. Link items only — mutating actions
// belong on the page they navigate to.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { msg } from "@/lib/messages";

export interface CardMenuItem {
  label: string;
  href: string;
  external?: boolean;
}

export function CardMenu({ items, name }: { items: CardMenuItem[]; name: string }) {
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

  if (items.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${msg("card.actions")}: ${name}`}
        onClick={() => setOpen((v) => !v)}
        className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 transition hover:bg-purple-50 hover:text-purple-700"
      >
        <MoreHorizontal className="h-4 w-4" strokeWidth={2} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-20 w-44 rounded-xl border border-purple-100 bg-white py-1 shadow-lg"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              role="menuitem"
              href={item.href}
              target={item.external ? "_blank" : undefined}
              onClick={() => setOpen(false)}
              className="block px-3 py-2 text-sm text-slate-700 hover:bg-purple-50 hover:text-purple-800"
            >
              {item.label}
              {item.external ? " ↗" : ""}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
