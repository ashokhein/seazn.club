"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight } from "lucide-react";
import { api } from "@/lib/client";
import type { OrgMembership } from "@/lib/types";
import { routes } from "@/lib/routes";

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-amber-100 text-amber-700",
  admin: "bg-purple-100 text-purple-700",
  viewer: "bg-slate-100 text-slate-600",
};

/**
 * Compact "Switch" trigger that sits beside the active org's name in the
 * settings header. Opens a right-aligned popover listing the other
 * organizations (plus a "create new" shortcut); closes on outside click.
 */
export function OrgSwitcher({
  orgs,
  activeId,
}: {
  orgs: OrgMembership[];
  activeId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function switchTo(id: string) {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setBusy(id);
    try {
      await api("/api/orgs/active", { method: "POST", json: { org_id: id } });
      // PROMPT-30: the URL owns which org a page shows — navigate to the
      // chosen org's settings; a cookie flip alone would change nothing.
      const slug = orgs.find((o) => o.id === id)?.slug;
      if (slug) router.push(routes.orgSettings(slug));
      router.refresh();
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch organisation"
        className="btn btn-ghost flex items-center gap-1.5"
      >
        <ArrowLeftRight className="h-3.5 w-3.5" strokeWidth={1.75} />
        Switch
      </button>

      {open && (
        <ul
          role="menu"
          className="absolute right-0 top-full z-30 mt-2 w-72 max-w-[85vw] space-y-1 rounded-xl border border-purple-100 bg-white p-2 shadow-xl"
        >
          {orgs.map((o) => {
            const isActive = o.id === activeId;
            return (
              <li key={o.id}>
                <button
                  type="button"
                  disabled={busy !== null || isActive}
                  onClick={() => switchTo(o.id)}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition ${
                    isActive
                      ? "border-purple-300 bg-purple-50"
                      : "border-purple-100 bg-white hover:border-purple-300 hover:shadow-sm"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-slate-800">
                      {o.name}
                    </span>
                    <span className="block truncate font-mono text-xs text-purple-400">
                      {o.slug}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`badge ${ROLE_BADGE[o.role]}`}>{o.role}</span>
                    {isActive ? (
                      <span className="text-xs font-medium text-purple-600">
                        Active
                      </span>
                    ) : busy === o.id ? (
                      <span className="text-xs text-slate-500">Switching…</span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => router.push("/orgs/new")}
              className="w-full rounded-lg border border-dashed border-purple-200 px-3 py-2 text-left text-sm font-medium text-purple-700 transition hover:border-purple-400 hover:bg-purple-50"
            >
              + New organization
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
