"use client";

// SPEC-3 signature element: the mark entry is FIVE scoreboard-digit tap targets
// (Barlow Condensed numerals 1–5 in scorebug tiles, selected tile lit lime),
// never stars — digits are scoreboard vernacular, stars are review-site
// vernacular. `MarkTiles` is a pure, hook-free presentational control so it
// stays directly testable in the node-env test workspace (no jsdom); the
// stateful `MarkControl` below wraps it with the PUT/DELETE + optimistic state.
import { useState } from "react";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";
import { useMsg } from "@/components/i18n/dict-provider";

const MARKS = [1, 2, 3, 4, 5] as const;

/** Pure five-tile rating control. One tap sets; keyboard-operable (each tile is
 *  a native button — Enter/Space activates — and the arrow keys move the
 *  selection). Selected tile is lit lime with `aria-pressed`. Hook-free (labels
 *  come in as props) so it stays directly callable in the node-env unit test;
 *  MarkControl supplies the localized labels. */
export function MarkTiles({
  value,
  onSet,
  disabled = false,
  ariaLabel = "Rate 1 to 5",
  labelFor = (n) => `Rate ${n} out of 5`,
}: {
  value: number | null;
  onSet: (mark: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
  labelFor?: (mark: number) => string;
}) {
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const cur = value ?? 0;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(5, cur + 1) || 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(1, cur - 1);
    if (next === null) return;
    e.preventDefault();
    onSet(next);
    // Client-only focus follow; guarded so the direct-call unit test (no DOM)
    // never touches `document`.
    if (typeof document !== "undefined") {
      document.getElementById(`mark-tile-${next}`)?.focus();
    }
  }
  return (
    <div role="group" aria-label={ariaLabel} onKeyDown={onKeyDown} className="inline-flex gap-1.5">
      {MARKS.map((n) => {
        const on = value === n;
        return (
          <button
            key={n}
            id={`mark-tile-${n}`}
            type="button"
            data-mark={n}
            disabled={disabled}
            aria-pressed={on}
            aria-label={labelFor(n)}
            onClick={() => onSet(n)}
            className={`app-display inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-xl font-bold tabular-nums shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-lime-400 focus-visible:ring-offset-1 disabled:opacity-50 ${
              on
                ? "bg-lime-400 text-slate-900"
                : "bg-slate-900 text-cream/70 hover:bg-slate-800 hover:text-cream"
            }`}
          >
            {n}
          </button>
        );
      })}
    </div>
  );
}

/** Stateful console control: the tiles plus the upsert/clear against the mark
 *  endpoints. Optimistic — the tap lights immediately, reverts on error. A 402
 *  (entitlement lost mid-session) reveals the upgrade gate inline; the panel
 *  otherwise never renders this for a community org. */
export function MarkControl({
  fixtureOfficialId,
  initialMark,
}: {
  fixtureOfficialId: string;
  initialMark: number | null;
}) {
  const msg = useMsg();
  const [mark, setMark] = useState<number | null>(initialMark);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gated, setGated] = useState(false);

  async function set(next: number) {
    const prev = mark;
    setMark(next);
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixture-officials/${fixtureOfficialId}/mark`, {
        method: "PUT",
        json: { mark: next },
      });
    } catch (err) {
      setMark(prev);
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") setGated(true);
      else setError(err instanceof Error ? err.message : msg("marks.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    const prev = mark;
    setMark(null);
    setBusy(true);
    setError(null);
    try {
      await apiV1(`/api/v1/fixture-officials/${fixtureOfficialId}/mark`, { method: "DELETE" });
    } catch (err) {
      setMark(prev);
      setError(err instanceof Error ? err.message : msg("marks.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (gated) return <UpgradeGate feature="officials.marks" compact />;

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div className="flex items-center gap-2">
        <MarkTiles
          value={mark}
          onSet={(n) => void set(n)}
          disabled={busy}
          ariaLabel={msg("marks.tiles.aria")}
          labelFor={(n) => msg("marks.tiles.set", { mark: n })}
        />
        {mark !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void clear()}
            className="inline-flex min-h-[44px] items-center text-xs text-slate-400 hover:text-red-500 hover:underline"
          >
            {msg("marks.clear")}
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
