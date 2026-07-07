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
