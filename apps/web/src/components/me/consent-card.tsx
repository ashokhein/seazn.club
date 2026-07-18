"use client";

// Player-owned consent card (PROMPT-53, doc 06 §4.7): one block per claimed
// profile (a player can exist at several clubs). Guardian-locked profiles
// render read-only with plain-language copy — the lock is server-enforced.
// v13 (PROMPT-65 §2): the card also carries the player's own photo control —
// upload/remove next to the public_photo consent it feeds.
import { useRef, useState } from "react";
import { apiV1 } from "@/lib/client-v1";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { type MessageKey } from "@/lib/messages";

export interface ConsentPerson {
  id: string;
  full_name: string;
  org_name: string;
  consent: { public_name?: boolean; public_photo?: boolean };
  consent_locked: boolean;
  /** false for a person only ever linked as an official — officials have no
   *  photo anywhere in the product, so the toggle would be meaningless. */
  hasPhotoFeature: boolean;
  /** Resolved photo URL (PROMPT-65) — null renders initials. */
  photo?: string | null;
}

const FLAGS: { key: "public_name" | "public_photo"; labelKey: MessageKey }[] = [
  { key: "public_name", labelKey: "me.consent.name" },
  { key: "public_photo", labelKey: "me.consent.photo" },
];

export function ConsentCard({ persons }: { persons: ConsentPerson[] }) {
  const msg = useMsg();
  const router = useRouter();
  const [state, setState] = useState(() =>
    Object.fromEntries(persons.map((p) => [p.id, p.consent])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busyPhoto, setBusyPhoto] = useState<string | null>(null);
  // Ref'd hidden input + button — never label-wrap a file input (repo gotcha).
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  async function uploadPhoto(person: ConsentPerson, file: File) {
    setBusyPhoto(person.id);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/v1/me/persons/${person.id}/photo`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `upload failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusyPhoto(null);
    }
  }

  async function removePhoto(person: ConsentPerson) {
    setBusyPhoto(person.id);
    setError(null);
    try {
      await apiV1(`/api/v1/me/persons/${person.id}/photo`, { method: "DELETE" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusyPhoto(null);
    }
  }

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
            {/* PROMPT-65 §2: my photo — preview + upload/remove. Locked
                profiles keep the organiser-managed photo untouched. */}
            {p.hasPhotoFeature && (
              <div className="mb-2 flex items-center gap-3" data-testid="me-photo">
                {p.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- storage URL
                  <img src={p.photo} alt="" className="h-12 w-12 rounded-lg object-cover" />
                ) : (
                  <span
                    aria-hidden
                    className="flex h-12 w-12 items-center justify-center rounded-lg bg-purple-50 text-sm font-bold text-purple-600"
                  >
                    {p.full_name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")}
                  </span>
                )}
                {!p.consent_locked && (
                  <span className="flex items-center gap-2">
                    <input
                      ref={(el) => {
                        fileInputs.current[p.id] = el;
                      }}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadPhoto(p, f);
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      disabled={busyPhoto === p.id}
                      onClick={() => fileInputs.current[p.id]?.click()}
                      className="btn btn-ghost px-2.5 py-1 text-xs"
                    >
                      {busyPhoto === p.id
                        ? msg("me.photo.working")
                        : p.photo
                          ? msg("me.photo.change")
                          : msg("me.photo.upload")}
                    </button>
                    {p.photo && (
                      <button
                        type="button"
                        disabled={busyPhoto === p.id}
                        onClick={() => void removePhoto(p)}
                        className="btn btn-ghost px-2.5 py-1 text-xs text-slate-400"
                      >
                        {msg("me.photo.remove")}
                      </button>
                    )}
                  </span>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              {FLAGS.filter((f) => f.key !== "public_photo" || p.hasPhotoFeature).map((f) => (
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
                  {msg(f.labelKey)}
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
