"use client";

// The check-in button + result states (PROMPT-53). needs_claim renders the
// claim-first interstitial: direction, not an error.
import { useState } from "react";
import { api } from "@/lib/client";
import { msg } from "@/lib/messages";

type State = "idle" | "busy" | "done" | "needs_claim";

export function CheckinAction({ token }: { token: string }) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);

  async function checkIn() {
    setState("busy");
    setError(null);
    try {
      const out = await api<{ checked_in?: boolean; needs_claim?: boolean }>(
        `/api/checkin/${token}`,
        { method: "POST" },
      );
      setState(out.needs_claim ? "needs_claim" : "done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check in");
      setState("idle");
    }
  }

  if (state === "done") {
    return (
      <div className="text-center" data-testid="checkin-done">
        <p className="text-3xl" aria-hidden>
          ✓
        </p>
        <h2 className="mt-1 text-lg font-bold text-emerald-700">{msg("checkin.done.title")}</h2>
        <p className="mt-1 text-sm text-slate-500">{msg("checkin.done.line")}</p>
      </div>
    );
  }

  if (state === "needs_claim") {
    return (
      <div className="text-center" data-testid="checkin-needs-claim">
        <h2 className="text-lg font-bold text-purple-900">{msg("checkin.needsClaim.title")}</h2>
        <p className="mt-1 text-sm text-slate-500">{msg("checkin.needsClaim.line")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button
        onClick={checkIn}
        disabled={state === "busy"}
        className="btn btn-primary w-full py-2.5"
      >
        {state === "busy" ? "Checking in…" : "I'm here — check in"}
      </button>
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
