"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export const FUNNEL_SPORTS = [
  "Badminton",
  "Table Tennis",
  "Tennis",
  "Chess",
  "Carrom",
  "Football",
  "Cricket",
  "Volleyball",
  "Other",
] as const;

/** Wrapper classes for the funnel form; exported for the night-variant
 *  regression test (the component itself needs the app router mounted). */
export function funnelFormClasses(compact: boolean, variant: "light" | "night"): string {
  return `mx-auto flex w-full max-w-2xl flex-col gap-2 sm:flex-row sm:items-end ${
    compact ? "" : "rounded-2xl border p-3 shadow-sm backdrop-blur"
  } ${variant === "night" ? "mk-funnel-night" : compact ? "" : "border-purple-200 bg-white/80"}`;
}

/** Hero funnel form (v3/07 §6): sport + field size + date, no auth — the
 *  visitor invests first, authenticates later on /start. */
export function StartFunnelForm({
  compact = false,
  variant = "light",
}: {
  compact?: boolean;
  variant?: "light" | "night";
}) {
  const router = useRouter();
  const [sport, setSport] = useState<string>("Football");
  const [entrants, setEntrants] = useState("16");
  const [date, setDate] = useState("");

  function go(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams({ sport, entrants });
    if (date) params.set("date", date);
    router.push(`/start?${params.toString()}`);
  }

  return (
    <form
      onSubmit={go}
      data-start-funnel
      className={funnelFormClasses(compact, variant)}
    >
      <label className="min-w-44 flex-1 text-left">
        <span className="label mb-1 block text-xs">Sport</span>
        <select
          value={sport}
          onChange={(e) => setSport(e.target.value)}
          className="input w-full"
          name="sport"
        >
          {FUNNEL_SPORTS.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <label className="w-full text-left sm:w-32">
        <span className="label mb-1 block text-xs">Players / teams</span>
        <input
          type="number"
          min={2}
          max={256}
          value={entrants}
          onChange={(e) => setEntrants(e.target.value)}
          className="input w-full"
          name="entrants"
        />
      </label>
      <label className="w-full text-left sm:w-40">
        <span className="label mb-1 block text-xs">Start date</span>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="input w-full"
          name="date"
        />
      </label>
      <button type="submit" className="btn btn-primary whitespace-nowrap px-4 py-2.5">
        Setup →
      </button>
    </form>
  );
}
