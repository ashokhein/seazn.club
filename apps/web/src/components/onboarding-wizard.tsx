"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SportPreset } from "@/lib/types";

const FORMAT_LABELS: Record<string, string> = {
  swiss_knockout: "Swiss → Knockout",
  round_robin: "Round Robin",
  knockout: "Knockout",
  progress_stepladder: "Stepladder",
};

export function OnboardingWizard({ presets }: { presets: SportPreset[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);

  async function skip() {
    setSkipping(true);
    await fetch("/api/onboarding/complete", { method: "POST" });
    router.push("/dashboard");
  }

  function proceed() {
    if (!selected) return;
    // Mark done server-side via the create-tournament flow itself is sufficient;
    // we also call /api/onboarding/complete so wizard doesn't reappear on refresh.
    fetch("/api/onboarding/complete", { method: "POST" }).catch(() => {});
    router.push(`/tournaments/new?preset=${selected}`);
  }

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2">
        {presets.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setSelected(p.id === selected ? null : p.id)}
            className={[
              "card cursor-pointer rounded-xl border-2 p-4 text-left transition",
              selected === p.id
                ? "border-purple-500 bg-purple-50 shadow-md"
                : "border-transparent hover:border-purple-200",
            ].join(" ")}
          >
            <p className="font-semibold text-slate-800">{p.sport_name}</p>
            <p className="mt-1 text-xs text-slate-500">
              {FORMAT_LABELS[p.format] ?? p.format} · {p.entity_label}
            </p>
          </button>
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
        <button
          type="button"
          onClick={proceed}
          disabled={!selected}
          className="btn btn-primary disabled:opacity-40"
        >
          Create my first tournament →
        </button>
      </div>
    </div>
  );
}
