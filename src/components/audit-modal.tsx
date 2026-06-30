"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Modal } from "@/components/modal";
import { ClientTime } from "@/components/client-time";
import type { AuditEntry } from "@/lib/types";

const ACTION_STYLE: Record<string, string> = {
  create: "bg-purple-100 text-purple-700",
  start: "bg-sky-100 text-sky-700",
  record_result: "bg-emerald-100 text-emerald-700",
  undo: "bg-amber-100 text-amber-700",
  reset: "bg-red-100 text-red-600",
  checkin: "bg-slate-100 text-slate-600",
};

const ACTION_LABEL: Record<string, string> = {
  create: "Created",
  start: "Started",
  record_result: "Result",
  undo: "Undo",
  reset: "Reset",
  checkin: "Check-in",
};

export function AuditModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AuditEntry[]>(`/api/tournaments/${id}/audit`)
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load"));
  }, [id]);

  return (
    <Modal title="Activity history" size="lg" onClose={onClose}>
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-red-600">{error}</p>
      )}
      {!entries && !error && <p className="text-slate-400">Loading…</p>}
      {entries && entries.length === 0 && (
        <p className="text-slate-400">No activity recorded yet.</p>
      )}
      {entries && entries.length > 0 && (
        <ol className="space-y-2">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex items-start gap-3 rounded-lg border border-purple-50 bg-white px-3 py-2"
            >
              <span
                className={`badge mt-0.5 shrink-0 ${
                  ACTION_STYLE[e.action] ?? "bg-slate-100 text-slate-600"
                }`}
              >
                {ACTION_LABEL[e.action] ?? e.action}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-slate-800">{e.summary}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {e.actor ?? "system"} ·{" "}
                  <ClientTime value={e.created_at} mode="datetime" />
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
