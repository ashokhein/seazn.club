"use client";

// The two division launch actions (doc 12 §1, PROMPT-17):
//  A. Start tournament — quick-start: generate → sequence-slot → active.
//  B. Schedule — plan-first: opens the drag-and-drop board (generate + auto
//     pass live there); publish and start follow from the board.
import { useState } from "react";
import Link from "@/components/ui/console-link";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { routes } from "@/lib/routes";
import { PUBLISH_BLOCKED, PUBLISH_UNACKNOWLEDGED } from "@/lib/schedule-board";
import { useMsg } from "@/components/i18n/dict-provider";
import { ScheduleGateDialog } from "@/components/v2/board/schedule-gate-dialog";
import type { BoardConflict, BoardFixture } from "@/components/v2/board/types";

interface Props {
  divisionId: string;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  status: string;
  canEdit: boolean;
  /** This division's fixtures and entrant names, only so the gate dialog can
   *  name the matches it is refusing. The page already holds both, so the sheet
   *  costs no extra read; `feedLabels` is NOT loaded for it — a knockout
   *  placeholder reads "TBD vs TBD" rather than "Winner of QF1", which is not
   *  worth a second query on every division page load. */
  fixtures: BoardFixture[];
  entrantNames: Record<string, string>;
}

export function LaunchActions({
  divisionId,
  orgSlug,
  compSlug,
  divSlug,
  status,
  canEdit,
  fixtures,
  entrantNames,
}: Props) {
  const msg = useMsg();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  // Starting PUBLISHES the schedule, so it is refused the two ways publish is
  // (#230 item 2 follow-up), and this is the button the pro and community
  // journeys actually press. Without this the 422 was flattened into
  // `err.message` in a red span, `extra.conflicts` was dropped, and there was
  // no control that could send `acknowledge_warnings` — the same dead end the
  // BOARD's start button had, left behind when that one was fixed.
  const [gate, setGate] = useState<{ kind: "blocking" | "warnings"; conflicts: BoardConflict[] } | null>(
    null,
  );

  async function start(acknowledgeWarnings = false) {
    setBusy(true);
    setError(null);
    try {
      const out = await apiV1<{ generated: number }>(`/api/v1/divisions/${divisionId}/start`, {
        method: "POST",
        // No body unless the organiser is acknowledging: /start parses an absent
        // one as `{}` and every existing key client POSTs it with none, so the
        // console must not start requiring one.
        json: acknowledgeWarnings ? { acknowledge_warnings: true } : undefined,
      });
      setGate(null);
      if (out.generated > 0) {
        router.push("?tab=fixtures");
      }
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? ""));
      } else if (
        err instanceof ApiV1Error &&
        (err.code === PUBLISH_BLOCKED || err.code === PUBLISH_UNACKNOWLEDGED)
      ) {
        // Re-opened rather than closed on a second refusal: an organiser who
        // acknowledges warnings while somebody else drags a card into a court
        // clash must be told THAT, not dropped back believing it started. `kind`
        // is read off the CODE, never recomputed from the rows — the server's
        // blocking test and the rows' own `blocking` flags disagree by design.
        setGate({
          kind: err.code === PUBLISH_BLOCKED ? "blocking" : "warnings",
          conflicts: (err.extra.conflicts as BoardConflict[] | undefined) ?? [],
        });
      } else {
        setError(err instanceof Error ? err.message : msg("launch.failedStart"));
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
          data-testid="launch-start-division"
          disabled={busy}
          onClick={() => void start()}
          className="btn btn-primary px-3 py-1.5 text-xs"
          title={msg("launch.startTitle")}
        >
          {busy ? msg("launch.starting") : msg("launch.start")}
        </button>
      )}
      <Link href={routes.divisionSchedule(orgSlug, compSlug, divSlug)} className="btn btn-ghost px-3 py-1.5 text-xs">
        {msg("launch.schedule")}
      </Link>
      {paywall && <UpgradeGate feature={paywall} compact />}
      {error && <span className="text-xs text-red-600">{error}</span>}
      {/* The way through the gate — and, for a blocking board, the honest report
          that there is none. Same dialog the board's start button opens, so the
          two paths to the same endpoint refuse identically. */}
      <ScheduleGateDialog
        gate={gate ? { ...gate, action: "start" } : null}
        board={fixtures}
        entrantNames={entrantNames}
        feedLabels={{}}
        busy={busy}
        onConfirm={() => void start(true)}
        onDismiss={() => setGate(null)}
      />
    </div>
  );
}
