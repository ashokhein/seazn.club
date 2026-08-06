"use client";

// Staff waiver for a division's V354 quota slot. Offered ONLY on divisions the
// slot rule is actually charging for (see `slotConsumingDivisions`) — a button
// that silently no-ops is worse than no button.
//
// Two-click confirm rather than `window.confirm`: this moves a paying
// customer's entitlement boundary and is audited, so the intent is worth
// asking for twice, and an in-page confirm stays usable at 375px where a
// native dialog does not compose with the row it belongs to.
//
// English only. /admin is staff-only and owes no dictionary keys.
import { useState } from "react";
import { useRouter } from "next/navigation";

/** ≥44px touch target (the standing mobile rule), at /admin's small type.
 *  `whitespace-nowrap` because this lives in the last column of a 4-column
 *  table: at 375px the cell is narrow enough to break a two-word label onto
 *  two lines and grow the row instead of scrolling the table. */
const BTN =
  "min-h-[44px] whitespace-nowrap rounded px-3 py-2 text-xs text-white disabled:opacity-40";

export function SlotWaiverButton({ divisionId }: { divisionId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function waive() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/divisions/${divisionId}/slot-waiver`, {
        method: "POST",
      });
      // 204, no body — only an error response is worth parsing.
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `Failed (${res.status})`);
      }
      setConfirming(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  if (!confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={`${BTN} bg-slate-700 hover:bg-slate-600`}
        >
          Waive slot
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* The row already names the division, so the prompt does not repeat it
          — at 375px that name wraps to one word per line inside this cell. */}
      <span className="text-xs text-amber-300">Give this slot back?</span>
      <button
        type="button"
        onClick={waive}
        disabled={loading}
        className={`${BTN} bg-red-800 hover:bg-red-700`}
      >
        {loading ? "Waiving…" : "Confirm waive"}
      </button>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        disabled={loading}
        className={`${BTN} bg-slate-700 hover:bg-slate-600`}
      >
        Cancel
      </button>
      {error && <span className="text-xs text-red-400">{error}</span>}
    </div>
  );
}
