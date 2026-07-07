"use client";

// Ladder console (Jul3/08 §6): the current order + a challenge form. A
// challenger picks an opponent within `challengeRange` places above; winning
// the created fixture swaps positions (the scoring hook does the reorder).
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1, ApiV1Error } from "@/lib/client-v1";
import { UpgradeGate } from "@/components/upgrade-gate";

interface Entrant {
  id: string;
  display_name: string;
}

export function LadderPanel({
  stageId,
  order,
  entrants,
  canEdit,
}: {
  stageId: string;
  order: string[]; // entrant ids, top first
  entrants: Record<string, string>; // id → display name
  canEdit: boolean;
}) {
  const router = useRouter();
  const [challenger, setChallenger] = useState("");
  const [opponent, setOpponent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ranked list — fall back to entrants insertion order before first challenge
  const ranked: Entrant[] =
    order.length > 0
      ? order.map((id) => ({ id, display_name: entrants[id] ?? id }))
      : Object.entries(entrants).map(([id, display_name]) => ({ id, display_name }));

  async function submit() {
    if (!challenger || !opponent) return;
    setError(null);
    setPaywall(null);
    setBusy(true);
    try {
      await apiV1(`/api/v1/stages/${stageId}/challenges`, {
        method: "POST",
        json: { challenger_id: challenger, opponent_id: opponent },
      });
      setChallenger("");
      setOpponent("");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiV1Error && err.code === "PAYMENT_REQUIRED") {
        setPaywall(String(err.extra.feature_key ?? "formats.advanced"));
      } else {
        setError(err instanceof Error ? err.message : "Failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {paywall && <UpgradeGate feature={paywall} />}
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th className="px-4 py-2 text-left">Rank</th>
              <th className="px-4 py-2 text-left">Player</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((e, i) => (
              <tr key={e.id} className="border-t border-slate-100">
                <td className="px-4 py-2 text-sm text-slate-400">{i + 1}</td>
                <td className="px-4 py-2 text-sm font-medium text-slate-900">{e.display_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && (
        <div className="card flex flex-wrap items-end gap-3 p-4">
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Challenger
            <select className="input" value={challenger} onChange={(e) => setChallenger(e.target.value)}>
              <option value="">—</option>
              {ranked.map((e) => (
                <option key={e.id} value={e.id}>{e.display_name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Challenges (must be above)
            <select className="input" value={opponent} onChange={(e) => setOpponent(e.target.value)}>
              <option value="">—</option>
              {ranked.filter((e) => e.id !== challenger).map((e) => (
                <option key={e.id} value={e.id}>{e.display_name}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-primary" disabled={busy || !challenger || !opponent} onClick={submit}>
            Issue challenge
          </button>
          <p className="w-full text-xs text-slate-500">
            You can only challenge someone ranked above you, within the ladder&apos;s reach.
            Winning the challenge fixture takes their position.
          </p>
        </div>
      )}
    </div>
  );
}
