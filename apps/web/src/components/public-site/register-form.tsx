"use client";

// Public registration form (doc 16 §1.1): division picker → eligibility-aware
// fields (DOB when the division carries an age rule; guardian consent appears
// when the DOB says minor) → custom form fields → submit. Paid divisions
// redirect straight to Stripe Checkout; free/waitlisted land on the status
// page, whose URL carries the one-time access token.
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiV1 } from "@/lib/client-v1";

export interface RegisterDivision {
  division_id: string;
  name: string;
  sport_key: string;
  entrant_kind: string;
  fee_cents: number;
  currency: string;
  opens_at: string | null;
  closes_at: string | null;
  capacity: number | null;
  remaining: number | null;
  open: boolean;
  closed_reason: string | null;
  requires_dob: boolean;
  form_fields: {
    key: string;
    label: string;
    kind: "text" | "select" | "checkbox";
    options?: string[];
    required: boolean;
  }[];
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

interface Player {
  name: string;
  dob: string;
  squad_number: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a pasted roster: one player per line, comma-separated fields in any
 *  order — a 4-digit-led token is a DOB, a short number is a squad number,
 *  everything else is the name. */
function parseRoster(text: string): Player[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((p) => p.trim()).filter(Boolean);
      const player: Player = { name: "", dob: "", squad_number: "" };
      for (const part of parts) {
        if (ISO_DATE.test(part)) player.dob = part;
        else if (/^\d{1,3}$/.test(part) && !player.squad_number) player.squad_number = part;
        else if (!player.name) player.name = part;
      }
      if (!player.name) player.name = parts[0] ?? "";
      return player;
    })
    .filter((p) => p.name);
}

function isMinorDob(dob: string): boolean {
  if (!dob) return false;
  const d = new Date(`${dob}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (
    now.getUTCMonth() < d.getUTCMonth() ||
    (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())
  ) {
    age -= 1;
  }
  return age < 18;
}

export function RegisterForm({
  orgSlug,
  competitionSlug,
  divisions,
}: {
  orgSlug: string;
  competitionSlug: string;
  divisions: RegisterDivision[];
}) {
  const router = useRouter();
  const [divisionId, setDivisionId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [players, setPlayers] = useState<Player[]>([]);
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const division = useMemo(
    () => divisions.find((d) => d.division_id === divisionId) ?? null,
    [divisions, divisionId],
  );
  const minor = dob !== "" && isMinorDob(dob);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!division) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiV1<{
        registration_id: string;
        status: string;
        access_token: string;
        checkout_url: string | null;
      }>(`/api/v1/public/orgs/${orgSlug}/competitions/${competitionSlug}/register`, {
        method: "POST",
        json: {
          division_id: division.division_id,
          display_name: displayName,
          contact_email: email,
          dob: dob || null,
          gender: gender || null,
          guardian_name: guardianName || null,
          guardian_consent: guardianConsent,
          answers,
          players:
            division.entrant_kind === "team"
              ? players
                  .filter((p) => p.name.trim())
                  .map((p) => ({
                    name: p.name.trim(),
                    dob: p.dob || null,
                    squad_number: p.squad_number ? Number(p.squad_number) : null,
                  }))
              : [],
        },
      });
      if (result.checkout_url) {
        window.location.assign(result.checkout_url);
        return;
      }
      router.push(
        `/shared/${orgSlug}/${competitionSlug}/register/status` +
          `?rid=${result.registration_id}&token=${encodeURIComponent(result.access_token)}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-6">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-zinc-700">Division</legend>
        <ul className="space-y-2">
          {divisions.map((d) => {
            const waitlist = d.open && d.remaining === 0;
            const disabled = !d.open;
            return (
              <li key={d.division_id}>
                <label
                  className={`flex items-center gap-3 rounded-xl border p-3 text-sm transition ${
                    disabled
                      ? "cursor-not-allowed border-zinc-100 bg-zinc-50 text-zinc-400"
                      : divisionId === d.division_id
                        ? "border-purple-500 bg-purple-50/50 shadow-sm ring-1 ring-purple-500"
                        : "cursor-pointer border-purple-100 bg-white hover:border-purple-300 hover:shadow-sm"
                  }`}
                >
                  <input
                    type="radio"
                    name="division"
                    disabled={disabled}
                    checked={divisionId === d.division_id}
                    onChange={() => setDivisionId(d.division_id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{d.name}</span>
                    <span className="mt-0.5 block text-xs text-zinc-500">
                      {d.sport_key} · {d.entrant_kind}
                      {d.remaining !== null && d.remaining > 0
                        ? ` · ${d.remaining} spots left`
                        : ""}
                      {waitlist ? " · full — joins the waitlist" : ""}
                      {disabled && d.closed_reason === "window" ? " · registration closed" : ""}
                      {disabled && d.closed_reason === "payments_unavailable"
                        ? " · payments not available yet"
                        : ""}
                    </span>
                  </span>
                  <span className="text-sm font-medium tabular-nums">
                    {d.fee_cents > 0 ? money(d.fee_cents, d.currency) : "Free"}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {division && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-zinc-700">
                {division.entrant_kind === "team" ? "Team name" : "Full name"} *
              </span>
              <input
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={120}
                className="mt-1 w-full rounded-lg border border-purple-200 px-3 py-2 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
              />
            </label>
            <label className="block text-sm">
              <span className="text-zinc-700">Contact email *</span>
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-purple-200 px-3 py-2 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
              />
            </label>
            <label className="block text-sm">
              <span className="text-zinc-700">
                Date of birth {division.requires_dob ? "*" : "(optional)"}
              </span>
              <input
                type="date"
                required={division.requires_dob}
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                className="mt-1 w-full rounded-lg border border-purple-200 px-3 py-2 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
              />
            </label>
            <label className="block text-sm">
              <span className="text-zinc-700">Gender (optional)</span>
              <select
                value={gender}
                onChange={(e) => setGender(e.target.value)}
                className="mt-1 w-full rounded-lg border border-purple-200 px-3 py-2 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
              >
                <option value="">—</option>
                <option value="f">Female</option>
                <option value="m">Male</option>
                <option value="x">Other / non-binary</option>
              </select>
            </label>
          </div>

          {minor && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-800">Under 18 — guardian consent</p>
              <label className="mt-2 block text-sm">
                <span className="text-zinc-700">Parent / guardian name *</span>
                <input
                  required
                  value={guardianName}
                  onChange={(e) => setGuardianName(e.target.value)}
                  maxLength={120}
                  className="mt-1 w-full rounded-lg border border-purple-200 px-3 py-2 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                />
              </label>
              <label className="mt-2 flex items-start gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  required
                  checked={guardianConsent}
                  onChange={(e) => setGuardianConsent(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I am the parent/guardian and consent to this registration and to the
                  competition&apos;s handling of the player&apos;s details.
                </span>
              </label>
            </div>
          )}

          {division.form_fields.length > 0 && (
            <div className="space-y-3">
              {division.form_fields.map((f) => (
                <label key={f.key} className="block text-sm">
                  {f.kind === "checkbox" ? (
                    <span className="flex items-start gap-2 text-zinc-700">
                      <input
                        type="checkbox"
                        required={f.required}
                        checked={answers[f.key] === true}
                        onChange={(e) =>
                          setAnswers((a) => ({ ...a, [f.key]: e.target.checked }))
                        }
                        className="mt-0.5"
                      />
                      <span>
                        {f.label} {f.required ? "*" : ""}
                      </span>
                    </span>
                  ) : (
                    <>
                      <span className="text-zinc-700">
                        {f.label} {f.required ? "*" : ""}
                      </span>
                      {f.kind === "select" ? (
                        <select
                          required={f.required}
                          value={(answers[f.key] as string) ?? ""}
                          onChange={(e) =>
                            setAnswers((a) => ({ ...a, [f.key]: e.target.value }))
                          }
                          className="mt-1 w-full rounded-lg border border-purple-200 px-3 py-2 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                        >
                          <option value="">—</option>
                          {(f.options ?? []).map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          required={f.required}
                          value={(answers[f.key] as string) ?? ""}
                          onChange={(e) =>
                            setAnswers((a) => ({ ...a, [f.key]: e.target.value }))
                          }
                          maxLength={1000}
                          className="mt-1 w-full rounded-lg border border-purple-200 px-3 py-2 outline-none transition focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                        />
                      )}
                    </>
                  )}
                </label>
              ))}
            </div>
          )}

          {division.entrant_kind === "team" && (
            <fieldset className="space-y-3 rounded-xl border border-purple-100 bg-purple-50/30 p-4">
              <legend className="px-1 text-sm font-medium text-zinc-700">
                Players (optional)
              </legend>
              <p className="text-xs text-zinc-500">
                Add your squad now, or leave blank and the organiser adds them later.
              </p>

              {players.length > 0 && (
                <ul className="space-y-2">
                  {players.map((p, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-2">
                      <input
                        aria-label={`Player ${i + 1} name`}
                        placeholder="Full name"
                        value={p.name}
                        onChange={(e) =>
                          setPlayers((ps) => ps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
                        }
                        maxLength={120}
                        className="min-w-40 flex-1 rounded-lg border border-purple-200 px-3 py-1.5 text-sm outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                      />
                      <input
                        aria-label={`Player ${i + 1} squad number`}
                        placeholder="#"
                        value={p.squad_number}
                        onChange={(e) =>
                          setPlayers((ps) =>
                            ps.map((x, j) =>
                              j === i ? { ...x, squad_number: e.target.value.replace(/\D/g, "").slice(0, 3) } : x,
                            ),
                          )
                        }
                        inputMode="numeric"
                        className="w-14 rounded-lg border border-purple-200 px-2 py-1.5 text-sm outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                      />
                      <input
                        aria-label={`Player ${i + 1} date of birth`}
                        type="date"
                        value={p.dob}
                        onChange={(e) =>
                          setPlayers((ps) => ps.map((x, j) => (j === i ? { ...x, dob: e.target.value } : x)))
                        }
                        className="rounded-lg border border-purple-200 px-2 py-1.5 text-sm outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                      />
                      <button
                        type="button"
                        onClick={() => setPlayers((ps) => ps.filter((_, j) => j !== i))}
                        className="rounded-md px-2 py-1 text-sm text-red-500 hover:bg-red-50"
                        aria-label={`Remove player ${i + 1}`}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <button
                type="button"
                onClick={() => setPlayers((ps) => (ps.length < 50 ? [...ps, { name: "", dob: "", squad_number: "" }] : ps))}
                className="rounded-lg border border-purple-300 bg-white px-3 py-1.5 text-sm font-medium text-purple-700 hover:bg-purple-50"
              >
                + Add player
              </button>

              <details className="text-sm">
                <summary className="cursor-pointer text-purple-700">Import a list</summary>
                <p className="mt-2 text-xs text-zinc-500">
                  One player per line. Optional squad number and date of birth (YYYY-MM-DD),
                  comma-separated — e.g. <code>Jordan Blake, 7, 2005-04-12</code>.
                </p>
                <textarea
                  value={importText}
                  onChange={(e) => setImportText(e.target.value)}
                  rows={4}
                  placeholder={"Jordan Blake, 7\nSam Ortiz, 10, 2004-11-30\nAlex Kim"}
                  className="mt-2 w-full rounded-lg border border-purple-200 px-3 py-2 text-sm outline-none focus:border-purple-500 focus:ring-2 focus:ring-purple-200"
                />
                <button
                  type="button"
                  onClick={() => {
                    const parsed = parseRoster(importText);
                    if (parsed.length === 0) return;
                    setPlayers((ps) => [...ps, ...parsed].slice(0, 50));
                    setImportText("");
                  }}
                  className="mt-2 rounded-lg border border-purple-300 bg-white px-3 py-1.5 text-sm font-medium text-purple-700 hover:bg-purple-50"
                >
                  Add {parseRoster(importText).length || ""} players from list
                </button>
              </details>
            </fieldset>
          )}

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-gradient-to-r from-purple-600 to-fuchsia-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:from-purple-700 hover:to-fuchsia-700 disabled:opacity-50"
          >
            {busy
              ? "…"
              : division.fee_cents > 0 && division.remaining !== 0
                ? `Register — entry fee ${money(division.fee_cents, division.currency)}`
                : "Submit registration"}
          </button>
        </>
      )}
    </form>
  );
}
