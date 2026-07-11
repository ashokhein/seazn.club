"use client";

// /start wizard (v3/07 §6): three steps in ~60 seconds, no auth. Step 2 IS
// the product demo — the same pure recommendFormats the console uses, live.
import { useMemo, useState } from "react";
import { api } from "@/lib/client";
import { recommendFormats, type Recommendation } from "@/lib/format-recommend";
import { FUNNEL_SPORTS } from "@/components/start-funnel-form";

interface Initial {
  sport?: string;
  entrants?: number;
  date?: string;
}

export function StartWizard({ initial }: { initial: Initial }) {
  const [step, setStep] = useState(0);
  const [sport, setSport] = useState(initial.sport ?? "Badminton");
  const [name, setName] = useState("");
  const [entrants, setEntrants] = useState(initial.entrants ?? 16);
  const [courts, setCourts] = useState(2);
  const [hours, setHours] = useState(4);
  const [format, setFormat] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; claim_url?: string } | null>(null);

  const recs: Recommendation[] = useMemo(
    () => recommendFormats({ entrants, courts, hours }),
    [entrants, courts, hours],
  );

  const compName = name.trim() || `${sport} tournament`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string; claim_url?: string }>("/api/funnel/start", {
        method: "POST",
        json: {
          email,
          name: compName,
          sport,
          entrants,
          ...(initial.date ? { start_date: initial.date } : {}),
          ...(format ? { format } : {}),
        },
      });
      setDone(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card p-8 text-center" data-funnel-done>
        <div className="mb-3 text-4xl">📬</div>
        <h2 className="text-xl font-bold text-slate-900">Check your email</h2>
        <p className="mt-2 text-sm text-slate-600">{done.message}</p>
        <p className="mt-2 text-xs text-slate-400">
          One click signs you in and creates “{compName}” — no password needed.
        </p>
        {done.claim_url && (
          <a
            href={done.claim_url}
            data-claim-url={done.claim_url}
            className="mt-4 inline-block text-xs text-purple-500 underline"
          >
            Open it now (dev)
          </a>
        )}
      </div>
    );
  }

  return (
    <div data-start-wizard>
      {/* Step rail */}
      <ol className="mb-6 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-wider">
        {["Name it", "Pick a format", "Get the link"].map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className="text-purple-200">—</span>}
            <span className={i <= step ? "text-purple-600" : "text-slate-300"}>
              {i + 1}. {label}
            </span>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <form
          className="card space-y-4 p-6"
          onSubmit={(e) => {
            e.preventDefault();
            setStep(1);
          }}
        >
          <label className="block">
            <span className="label mb-1 block">Sport</span>
            <select value={sport} onChange={(e) => setSport(e.target.value)} className="input w-full">
              {FUNNEL_SPORTS.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label mb-1 block">Competition name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${sport} tournament`}
              className="input w-full"
              maxLength={200}
            />
          </label>
          <label className="block">
            <span className="label mb-1 block">Players or teams</span>
            <input
              type="number"
              min={2}
              max={256}
              value={entrants}
              onChange={(e) => setEntrants(Math.max(2, Number(e.target.value) || 2))}
              className="input w-full"
            />
          </label>
          <button type="submit" className="btn btn-primary w-full justify-center py-2.5">
            Recommend a format →
          </button>
        </form>
      )}

      {step === 1 && (
        <div className="card space-y-4 p-6">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label mb-1 block">Courts / pitches</span>
              <input
                type="number"
                min={1}
                max={32}
                value={courts}
                onChange={(e) => setCourts(Math.max(1, Number(e.target.value) || 1))}
                className="input w-full"
              />
            </label>
            <label className="block">
              <span className="label mb-1 block">Hours available</span>
              <input
                type="number"
                min={1}
                max={72}
                value={hours}
                onChange={(e) => setHours(Math.max(1, Number(e.target.value) || 1))}
                className="input w-full"
              />
            </label>
          </div>

          <div className="space-y-2" role="radiogroup" aria-label="Recommended formats">
            {recs.map((r, i) => (
              <button
                key={r.slug}
                type="button"
                role="radio"
                aria-checked={format === r.slug || (format === null && i === 0)}
                onClick={() => setFormat(r.slug)}
                className={`w-full rounded-xl border p-4 text-left transition ${
                  format === r.slug || (format === null && i === 0)
                    ? "border-purple-400 bg-purple-50"
                    : "border-slate-200 hover:border-purple-200"
                }`}
              >
                <p className="flex items-center justify-between font-semibold text-slate-800">
                  {r.title}
                  {i === 0 && (
                    <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-bold uppercase text-purple-600">
                      Best fit
                    </span>
                  )}
                </p>
                <p className="mt-1 text-sm text-slate-500">{r.reason}</p>
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <button type="button" onClick={() => setStep(0)} className="btn btn-ghost flex-none">
              ← Back
            </button>
            <button
              type="button"
              onClick={() => {
                if (!format && recs[0]) setFormat(recs[0].slug);
                setStep(2);
              }}
              className="btn btn-primary flex-1 justify-center"
            >
              Looks right →
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <form className="card space-y-4 p-6" onSubmit={submit}>
          <div className="rounded-xl bg-purple-50 p-4 text-sm text-purple-900">
            <p className="font-semibold">“{compName}”</p>
            <p className="mt-1 text-purple-700">
              {sport} · {entrants} entrants ·{" "}
              {recs.find((r) => r.slug === format)?.title ?? recs[0]?.title}
            </p>
          </div>
          <label className="block">
            <span className="label mb-1 block">Your email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@club.org"
              className="input w-full"
              maxLength={120}
            />
          </label>
          <p className="text-xs text-slate-400">
            We’ll email you one link that signs you in and creates the
            competition. No password, no spam.
          </p>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => setStep(1)} className="btn btn-ghost flex-none">
              ← Back
            </button>
            <button type="submit" disabled={busy} className="btn btn-primary flex-1 justify-center">
              {busy ? "Sending…" : "Email me the link →"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
