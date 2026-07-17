"use client";
// Fixture-page officials strip (design v11 §D2): who's assigned, with a status
// chip. A red "Declined" badge (+ reason) is the organiser's cue to re-pick.
// Same chip grammar as the /me officiating-lane response rail.
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";

interface StripOfficial {
  official_id: string;
  name: string;
  role: string;
  response?: string;
  decline_reason?: string | null;
}

const CHIP: Record<string, string> = {
  accepted: "bg-lime-100 text-lime-800",
  pending: "bg-amber-100 text-amber-800",
  declined: "bg-red-100 text-red-700",
};

// Static map, not a template literal — repo i18n convention forbids dynamic
// message keys (they must be enumerable/checkable against MessageKey).
const STATE_LABEL: Record<string, MessageKey> = {
  accepted: "fixture.officials.accepted",
  pending: "fixture.officials.pending",
  declined: "fixture.officials.declined",
};

export function FixtureOfficialsStrip({ officials }: { officials: StripOfficial[] }) {
  const msg = useMsg();
  if (officials.length === 0) return null;
  return (
    <section
      className="mb-4 rounded-lg border border-slate-200 bg-white p-3"
      aria-label={msg("fixture.officials.title")}
    >
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        {msg("fixture.officials.title")}
      </p>
      <ul className="flex flex-wrap gap-2">
        {officials.map((o) => {
          const state = o.response ?? "accepted";
          return (
            <li
              key={`${o.official_id}:${o.role}`}
              className="flex items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs"
            >
              <span className="font-medium text-slate-700">{o.name}</span>
              <span className="text-slate-400 capitalize">{o.role}</span>
              <span
                className={`rounded px-1.5 py-0.5 font-semibold ${CHIP[state] ?? CHIP.pending}`}
                title={state === "declined" && o.decline_reason ? o.decline_reason : undefined}
              >
                {msg(STATE_LABEL[state] ?? STATE_LABEL.pending)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
