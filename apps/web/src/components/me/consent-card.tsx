"use client";

// Player-owned consent card (PROMPT-53, doc 06 §4.7): one block per claimed
// profile (a player can exist at several clubs). Guardian-locked profiles
// render read-only with plain-language copy — the lock is server-enforced.
import { useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { msg } from "@/lib/messages";

export interface ConsentPerson {
  id: string;
  full_name: string;
  org_name: string;
  consent: { public_name?: boolean; public_photo?: boolean };
  consent_locked: boolean;
}

const FLAGS = [
  { key: "public_name" as const, label: () => msg("me.consent.name") },
  { key: "public_photo" as const, label: () => msg("me.consent.photo") },
];

export function ConsentCard({ persons }: { persons: ConsentPerson[] }) {
  const [state, setState] = useState(() =>
    Object.fromEntries(persons.map((p) => [p.id, p.consent])),
  );
  const [error, setError] = useState<string | null>(null);

  async function toggle(person: ConsentPerson, key: "public_name" | "public_photo") {
    const prev = state[person.id];
    const next = { ...prev, [key]: !prev[key] };
    setState((s) => ({ ...s, [person.id]: next }));
    setError(null);
    try {
      await apiV1(`/api/v1/me/persons/${person.id}/consent`, {
        method: "PATCH",
        json: { [key]: next[key] },
      });
    } catch (err) {
      setState((s) => ({ ...s, [person.id]: prev }));
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <section className="card p-4">
      <h2 className="mb-1 text-sm font-semibold text-slate-800">{msg("me.consent.title")}</h2>
      <p className="mb-3 text-xs text-slate-500">{msg("me.consent.line")}</p>
      <div className="space-y-4">
        {persons.map((p) => (
          <div key={p.id}>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400">
              {p.full_name} · {p.org_name}
            </p>
            <div className="space-y-1.5">
              {FLAGS.map((f) => (
                <label
                  key={f.key}
                  className={`flex items-center gap-2 text-sm ${
                    p.consent_locked ? "text-slate-400" : "text-slate-600"
                  }`}
                >
                  <input
                    type="checkbox"
                    disabled={p.consent_locked}
                    checked={!!state[p.id]?.[f.key]}
                    onChange={() => toggle(p, f.key)}
                    className="h-4 w-4 rounded border-purple-200 accent-purple-600"
                  />
                  {f.label()}
                </label>
              ))}
            </div>
            {p.consent_locked && (
              <p className="mt-1 text-xs text-slate-400">{msg("me.consent.locked")}</p>
            )}
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </section>
  );
}
