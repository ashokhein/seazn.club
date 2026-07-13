"use client";

// RSVP segmented control (PROMPT-53): In / Maybe / Out as three floodlit
// buttons, optimistic write, note folds out once a state is picked. `onDark`
// styles it for the Next-match night hero; default is the light list rows.
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { msg } from "@/lib/messages";

type Status = "in" | "out" | "maybe";

const OPTIONS: { value: Status; mark: string; label: () => string }[] = [
  { value: "in", mark: "✓", label: () => msg("me.rsvp.in") },
  { value: "maybe", mark: "?", label: () => msg("me.rsvp.maybe") },
  { value: "out", mark: "✗", label: () => msg("me.rsvp.out") },
];

const ACTIVE: Record<Status, string> = {
  in: "bg-emerald-500 border-emerald-500 text-white",
  maybe: "bg-amber-400 border-amber-400 text-slate-900",
  out: "bg-zinc-500 border-zinc-500 text-white",
};

export function RsvpControl({
  fixtureId,
  initial,
  checkedInAt,
  onDark = false,
}: {
  fixtureId: string;
  initial: { status: Status; note: string | null } | null;
  checkedInAt: string | null;
  onDark?: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(initial?.status ?? null);
  const [note, setNote] = useState(initial?.note ?? "");
  const [savedNote, setSavedNote] = useState(initial?.note ?? "");
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: Status, nextNote: string) {
    const prev = status;
    setStatus(next);
    setError(null);
    try {
      await apiV1(`/api/v1/me/fixtures/${fixtureId}/availability`, {
        method: "PUT",
        json: { status: next, note: nextNote.trim() || null },
      });
      setSavedNote(nextNote);
      setFlash(true);
      setTimeout(() => setFlash(false), 1600);
    } catch (err) {
      setStatus(prev);
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  const idle = onDark
    ? "border-cream/25 text-cream/80 hover:border-cream/60"
    : "border-slate-200 text-slate-500 hover:border-slate-400";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Availability">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={status === o.value}
            onClick={() => save(o.value, note)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
              status === o.value ? ACTIVE[o.value] : idle
            }`}
          >
            <span aria-hidden>{o.mark}</span>
            {o.label()}
          </button>
        ))}
        {checkedInAt && (
          <span className="badge bg-lime-100 text-lime-800">{msg("me.checkedin")}</span>
        )}
        {flash && (
          <span className={`text-xs ${onDark ? "text-lime-400" : "text-emerald-600"}`}>
            {msg("me.rsvp.saved")}
          </span>
        )}
      </div>
      {status && (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => {
            if (note !== savedNote && status) void save(status, note);
          }}
          placeholder={msg("me.rsvp.notePlaceholder")}
          aria-label={msg("me.rsvp.notePlaceholder")}
          className={
            onDark
              ? "w-full rounded-md border border-cream/20 bg-white/5 px-3 py-1.5 text-sm text-cream placeholder:text-cream/40 focus:border-lime-400 focus:outline-none"
              : "input py-1.5 text-sm"
          }
        />
      )}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
