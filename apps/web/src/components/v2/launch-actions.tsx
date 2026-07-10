"use client";

// The two division launch actions (doc 12 §1, PROMPT-17):
//  A. Start tournament — quick-start: generate → sequence-slot → active.
//  B. Schedule — plan-first: opens the drag-and-drop board (generate + auto
//     pass live there); publish and start follow from the board.
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { routes } from "@/lib/routes";

interface Props {
  divisionId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  status: string;
  canEdit: boolean;
}

export function LaunchActions({ divisionId, orgSlug, compSlug, divSlug, status, canEdit }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const out = await apiV1<{ generated: number }>(`/api/v1/divisions/${divisionId}/start`, {
        method: "POST",
      });
      if (out.generated > 0) {
        router.push("?tab=fixtures");
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? ""));
      } else {
        setError(err instanceof Error ? err.message : "Failed to start");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canEdit && (status === "setup" || status === "scheduled") && (
        <button
          type="button"
          disabled={busy}
          onClick={start}
          className="btn btn-primary px-3 py-1.5 text-xs"
          title="Quick-start: generate first-stage fixtures and open scoring now"
        >
          {busy ? "Starting…" : "Start tournament"}
        </button>
      )}
      <Link href={routes.divisionSchedule(orgSlug, compSlug, divSlug)} className="btn btn-ghost px-3 py-1.5 text-xs">
        Schedule
      </Link>
      {paywall && <UpgradeGate feature={paywall} compact />}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
