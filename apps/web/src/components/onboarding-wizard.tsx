"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface SportOption {
  key: string;
  name: string;
}

const SPORT_EMOJI: Record<string, string> = {
  football: "⚽",
  cricket: "🏏",
  volleyball: "🏐",
  badminton: "🏸",
  tabletennis: "🏓",
  boardgame: "♟️",
  generic: "🏅",
};

export function OnboardingWizard({ sports }: { sports: SportOption[] }) {
  const router = useRouter();
  const [skipping, setSkipping] = useState(false);

  async function skip() {
    setSkipping(true);
    await fetch("/api/onboarding/complete", { method: "POST" });
    router.push("/dashboard");
  }

  function proceed() {
    // Mark done server-side so the wizard doesn't reappear on refresh.
    fetch("/api/onboarding/complete", { method: "POST" }).catch(() => {});
    router.push("/competitions/new");
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        {sports.map((s) => (
          <div key={s.key} className="card flex items-center gap-3 p-4">
            <span className="text-2xl">{SPORT_EMOJI[s.key] ?? "🏅"}</span>
            <div>
              <p className="font-semibold text-slate-800">{s.name}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                Scoring rules, formats and standings built in.
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 flex items-center justify-between gap-4">
        <button
          type="button"
          onClick={skip}
          disabled={skipping}
          className="text-sm text-slate-400 hover:text-slate-600 disabled:opacity-50"
        >
          Skip for now
        </button>
        <button type="button" onClick={proceed} className="btn btn-primary">
          Create my first competition →
        </button>
      </div>
    </div>
  );
}
