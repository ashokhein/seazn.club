"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import type { OrgMembership } from "@/lib/types";

const ROLE_BADGE: Record<string, string> = {
  owner: "bg-amber-100 text-amber-700",
  admin: "bg-purple-100 text-purple-700",
  viewer: "bg-slate-100 text-slate-600",
};

/**
 * Shows a "Switch" button next to the active org. Clicking it reveals the
 * other organizations to choose from (plus a "create new" shortcut).
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

  async function switchTo(id: string) {
    if (id === activeId) {
      setOpen(false);
      return;
    }
    setBusy(id);
    try {
      await api("/api/orgs/active", { method: "POST", json: { org_id: id } });
      router.refresh();
    } finally {
      setBusy(null);
      setOpen(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-ghost"
      >
        {open ? "Cancel" : "Switch organization"}
      </button>

      {open && (
        <ul className="mt-3 space-y-2">
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
                      <span className="text-xs text-slate-400">Switching…</span>
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
