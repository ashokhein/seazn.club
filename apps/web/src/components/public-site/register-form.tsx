"use client";

// Public registration form v2 (v3/05 §2, PROMPT-34). The page is a ticket,
// not a form: event masthead up top (org, competition, dates, fee, capacity
// meter), then ONE ordered section list rendered from a single config array
// — identity → event questions → consent → submit — so the #20 bug class
// (custom fields appended after the button) is structurally impossible.
// Youth divisions (v3/11 gap 8) always include the guardian-consent preset.
import { useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { apiV1 } from "@/lib/client-v1";
import { useMsg } from "@/components/i18n/dict-provider";
import { Tip } from "@/components/ui/tip";
import { PoweredByStripe } from "@/components/powered-by-stripe";

export interface RegisterCompetition {
  name: string;
  slug: string;
  starts_on: string | null;
  ends_on: string | null;
}

export interface RegisterOrg {
  name: string;
  slug: string;
  logo_url: string | null;
}

export interface RegisterDivision {
  division_id: string;
  name: string;
  sport_key: string;
  entrant_kind: string;
  fee_cents: number;
  currency: string;
  payment_method: "offline" | "stripe";
  opens_at: string | null;
  closes_at: string | null;
  capacity: number | null;
  remaining: number | null;
  taken: number;
  open: boolean;
  closed_reason: string | null;
  requires_dob: boolean;
  /** Queue length behind a full division (PROMPT-52). */
  waitlisted: number;
  youth: boolean;
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

const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-base outline-none transition focus:border-accent focus:ring-2 focus:ring-accent-line sm:text-sm";

export function RegisterForm({
  org,
  competition,
  divisions,
}: {
  org: RegisterOrg;
  competition: RegisterCompetition;
  divisions: RegisterDivision[];
}) {
  const msg = useMsg();
  const router = useRouter();
  const [divisionId, setDivisionId] = useState<string | null>(
    divisions.length === 1 ? (divisions[0]?.division_id ?? null) : null,
  );
  const [displayName, setDisplayName] = useState("");
  const [partnerName, setPartnerName] = useState("");
  const [email, setEmail] = useState("");
  const [dob, setDob] = useState("");
  const [gender, setGender] = useState("");
  const [guardianName, setGuardianName] = useState("");
  const [guardianConsent, setGuardianConsent] = useState(false);
  const [privacyConsent, setPrivacyConsent] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [players, setPlayers] = useState<Player[]>([]);
  const [importText, setImportText] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — humans never see it
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const division = useMemo(
    () => divisions.find((d) => d.division_id === divisionId) ?? null,
    [divisions, divisionId],
  );
  // Guardian consent: always on youth divisions (v3/11 gap 8), and for any
  // registrant whose DOB says minor.
  const needsGuardian = (division?.youth ?? false) || (dob !== "" && isMinorDob(dob));
  const waitlist = division ? division.open && division.remaining === 0 : false;

  const dates = competition.starts_on
    ? `${competition.starts_on}${
        competition.ends_on && competition.ends_on !== competition.starts_on
          ? ` – ${competition.ends_on}`
          : ""
      }`
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!division) return;
    setBusy(true);
    setError(null);
    const composedName =
      division.entrant_kind === "pair" && partnerName.trim()
        ? `${displayName.trim()} & ${partnerName.trim()}`
        : displayName.trim();
    try {
      const result = await apiV1<{
        registration_id: string;
        status: string;
        access_token: string;
        checkout_url: string | null;
      }>(`/api/v1/public/orgs/${org.slug}/competitions/${competition.slug}/register`, {
        method: "POST",
        json: {
          division_id: division.division_id,
          display_name: composedName,
          contact_email: email,
          dob: dob || null,
          gender: gender || null,
          guardian_name: guardianName || null,
          guardian_consent: guardianConsent,
          privacy_consent: privacyConsent,
          answers,
          website: website || undefined,
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
        `/shared/${org.slug}/${competition.slug}/register/status` +
          `?rid=${result.registration_id}&token=${encodeURIComponent(result.access_token)}`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed");
      setBusy(false);
    }
  }

  const submitLabel = !division
    ? msg("register.submit.free")
    : division.fee_cents > 0 && !waitlist
      ? msg(
          division.payment_method === "stripe" ? "register.submit.card" : "register.submit.fee",
          { fee: money(division.fee_cents, division.currency) },
        )
      : waitlist
        ? msg("register.full.waitlist")
        : msg("register.submit.free");

  // ── THE ordered section list (v3/05 §2). Rendering walks this array and
  // nothing else, so a section can never end up below the submit button. ──
  const sections: { key: string; title?: string; show: boolean; body: ReactNode }[] = division
    ? [
        {
          key: "identity",
          title: msg("register.section.identity"),
          show: true,
          body: (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm">
                <span className="text-zinc-700">
                  {division.entrant_kind === "team"
                    ? "Team name"
                    : division.entrant_kind === "pair"
                      ? "Your name"
                      : "Full name"}{" "}
                  *
                </span>
                <input
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={120}
                  className={INPUT_CLASS}
                />
              </label>
              {division.entrant_kind === "pair" && (
                <label className="block text-sm">
                  <span className="text-zinc-700">Partner&apos;s name *</span>
                  <input
                    required
                    value={partnerName}
                    onChange={(e) => setPartnerName(e.target.value)}
                    maxLength={120}
                    className={INPUT_CLASS}
                  />
                </label>
              )}
              <label className="block text-sm">
                <span className="text-zinc-700">Contact email *</span>
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={INPUT_CLASS}
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
                  className={INPUT_CLASS}
                />
              </label>
              <label className="block text-sm">
                <span className="text-zinc-700">Gender (optional)</span>
                <select value={gender} onChange={(e) => setGender(e.target.value)} className={INPUT_CLASS}>
                  <option value="">—</option>
                  <option value="f">Female</option>
                  <option value="m">Male</option>
                  <option value="x">Other / non-binary</option>
                </select>
              </label>
              {division.entrant_kind === "team" && (
                <TeamRoster
                  players={players}
                  setPlayers={setPlayers}
                  importText={importText}
                  setImportText={setImportText}
                />
              )}
            </div>
          ),
        },
        {
          key: "questions",
          title: msg("register.section.questions"),
          show: division.form_fields.length > 0,
          body: (
            <div className="space-y-3">
              {division.form_fields.map((f) => (
                <label key={f.key} className="block text-sm">
                  {f.kind === "checkbox" ? (
                    <span className="flex items-start gap-2 text-zinc-700">
                      <input
                        type="checkbox"
                        required={f.required}
                        checked={answers[f.key] === true}
                        onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.checked }))}
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
                          onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}
                          className={INPUT_CLASS}
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
                          onChange={(e) => setAnswers((a) => ({ ...a, [f.key]: e.target.value }))}
                          maxLength={1000}
                          className={INPUT_CLASS}
                        />
                      )}
                    </>
                  )}
                </label>
              ))}
            </div>
          ),
        },
        {
          key: "consent",
          title: msg("register.section.consent"),
          show: true,
          body: (
            <div className="space-y-3">
              {/* GDPR (spec 2026-07-14): explicit processing consent, every registrant. */}
              <label className="flex items-start gap-2 text-sm text-zinc-700">
                <input
                  type="checkbox"
                  required
                  checked={privacyConsent}
                  onChange={(e) => setPrivacyConsent(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  {msg("register.consent.data", { org: org.name })}{" "}
                  <a
                    href="/legal/privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    {msg("register.consent.privacy")}
                  </a>{" "}
                  *
                </span>
              </label>
              {needsGuardian && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-amber-800">
                    {msg("register.guardian.title")}
                    <Tip id="register.youth" />
                  </p>
                  <label className="mt-2 block text-sm">
                    <span className="text-zinc-700">Parent / guardian name *</span>
                    <input
                      required
                      value={guardianName}
                      onChange={(e) => setGuardianName(e.target.value)}
                      maxLength={120}
                      className={INPUT_CLASS}
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
            </div>
          ),
        },
      ]
    : [];

  return (
    <form onSubmit={submit} className="mt-6 space-y-6">
      {/* Event masthead (v3/05 §2): who/where/when + honest urgency. */}
      <header className="overflow-hidden rounded-2xl border border-zinc-200 bg-surface">
        <div className="flex items-center gap-4 px-5 py-4">
          {org.logo_url ? (
            // resolveLogoUrl(...) output — storage-served, covered by remotePatterns.
            <Image
              src={org.logo_url}
              alt=""
              width={48}
              height={48}
              className="h-12 w-12 rounded-lg border border-zinc-200 bg-white object-contain p-1"
            />
          ) : null}
          <div className="min-w-0">
            <p className="text-xs tracking-widest text-ink-muted uppercase">{org.name}</p>
            <h2 className="truncate font-display text-2xl leading-tight font-bold tracking-tight text-ink uppercase">
              {competition.name}
            </h2>
            <p className="text-sm text-ink-muted">
              {division ? `${division.name} · ` : ""}
              {dates ?? "Dates to be announced"}
            </p>
          </div>
        </div>
        {division && division.capacity !== null && (
          <div className="border-t border-zinc-200 px-5 py-3">
            <div className="flex items-center justify-between text-xs text-ink-muted">
              <span>
                {msg("register.capacity.taken", {
                  taken: Math.min(division.taken, division.capacity),
                  capacity: division.capacity,
                })}
              </span>
              {division.remaining !== null && division.remaining > 0 && (
                <span>{msg("register.capacity.left", { n: division.remaining })}</span>
              )}
            </div>
            <div
              role="meter"
              aria-valuemin={0}
              aria-valuemax={division.capacity}
              aria-valuenow={Math.min(division.taken, division.capacity)}
              aria-label="Spots taken"
              className="mt-1.5 h-2 overflow-hidden rounded-full bg-zinc-200"
            >
              <div
                className="h-full rounded-full bg-accent"
                style={{
                  width: `${Math.min(100, (division.taken / division.capacity) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
      </header>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-zinc-700">Division</legend>
        <ul className="space-y-2">
          {divisions.map((d) => {
            const dWaitlist = d.open && d.remaining === 0;
            const disabled = !d.open;
            return (
              <li key={d.division_id}>
                <label
                  className={`flex items-center gap-3 rounded-xl border p-3 text-sm transition ${
                    disabled
                      ? "cursor-not-allowed border-zinc-100 bg-zinc-50 text-zinc-400"
                      : divisionId === d.division_id
                        ? "border-accent bg-accent-soft shadow-sm ring-1 ring-accent"
                        : "cursor-pointer border-zinc-200 bg-white hover:border-accent-line hover:shadow-sm"
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
                      {d.fee_cents > 0
                        ? ` · ${msg(d.payment_method === "stripe" ? "register.method.card" : "register.method.offline")}`
                        : ""}
                      {d.remaining !== null && d.remaining > 0
                        ? ` · ${msg("register.capacity.left", { n: d.remaining })}`
                        : ""}
                      {dWaitlist
                        ? d.waitlisted > 0
                          ? ` · full — waitlist: ${d.waitlisted}`
                          : " · full — joins the waitlist"
                        : ""}
                      {disabled && d.closed_reason === "window" ? " · registration closed" : ""}
                      {disabled && d.closed_reason === "payments_unavailable"
                        ? " · card payments temporarily unavailable"
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

      {/* Full/closed are directions, not dead ends (v3/05 §2). */}
      {division && !division.open && (
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600">
          <p className="font-medium text-zinc-800">
            {division.closed_reason === "payments_unavailable"
              ? msg("register.payments.unavailable.title")
              : msg("register.closed.title")}
          </p>
          {division.closed_reason === "payments_unavailable" && (
            <p className="mt-0.5">{msg("register.payments.unavailable.body")}</p>
          )}
          <a
            href={`/shared/${org.slug}/${competition.slug}`}
            className="mt-1 inline-block font-medium text-accent-strong hover:underline"
          >
            {msg("register.closed.dashboard")} →
          </a>
        </div>
      )}
      {waitlist && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
          <p className="font-medium">{msg("register.full.title")}</p>
          {division && division.fee_cents > 0 && (
            <p className="mt-0.5 font-medium">{msg("register.waitlist.noPayment")}</p>
          )}
          <p className="mt-0.5">
            Submitting joins the waitlist — you&apos;re promoted automatically if a spot opens. Or{" "}
            <a
              href={`/shared/${org.slug}/${competition.slug}`}
              className="font-medium underline hover:no-underline"
            >
              {msg("register.full.dashboard").toLowerCase()}
            </a>
            .
          </p>
        </div>
      )}

      {division?.open &&
        sections
          .filter((s) => s.show)
          .map((s, i) => (
            <section key={s.key} data-section={s.key} aria-label={s.title}>
              {s.title && (
                <h3 className="mb-2 text-sm font-semibold text-zinc-800">
                  <span className="mr-1.5 text-ink-muted tabular-nums">{i + 1}</span>
                  {s.title}
                </h3>
              )}
              {s.body}
            </section>
          ))}

      {/* Honeypot (v3/05 §4): invisible to people, irresistible to bots. */}
      <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label>
          Website
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}

      {division?.open && (
        /* Sticky on mobile with the fee on the button (v3/02 pattern 2). */
        <div data-section="submit" className="bottom-bar">
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-accent px-6 py-3 text-sm font-semibold text-accent-ink shadow-sm transition hover:bg-accent-strong disabled:opacity-50 sm:w-auto"
          >
            {busy ? "…" : submitLabel}
          </button>
        </div>
      )}
      {division?.open && <div className="bottom-bar-spacer" aria-hidden />}
      {/* Official "Powered by Stripe" lockup, centered below the pay button —
          only for card-paid divisions, where Stripe actually takes the fee.
          Registration is the one public surface that carries it; the shared
          layout footer stays badge-free. Light page (bg-canvas) → blurple. */}
      {division?.open && division.payment_method === "stripe" && (
        <p className="flex justify-center pt-1">
          <PoweredByStripe
            variant="blurple"
            width={110}
            className="inline-block opacity-70 transition hover:opacity-100"
          />
        </p>
      )}
    </form>
  );
}

function TeamRoster({
  players,
  setPlayers,
  importText,
  setImportText,
}: {
  players: Player[];
  setPlayers: React.Dispatch<React.SetStateAction<Player[]>>;
  importText: string;
  setImportText: React.Dispatch<React.SetStateAction<string>>;
}) {
  return (
    <fieldset className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 sm:col-span-2">
      <legend className="px-1 text-sm font-medium text-zinc-700">Players (optional)</legend>
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
                className="min-w-40 flex-1 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-line"
              />
              <input
                aria-label={`Player ${i + 1} squad number`}
                placeholder="#"
                value={p.squad_number}
                onChange={(e) =>
                  setPlayers((ps) =>
                    ps.map((x, j) =>
                      j === i
                        ? { ...x, squad_number: e.target.value.replace(/\D/g, "").slice(0, 3) }
                        : x,
                    ),
                  )
                }
                inputMode="numeric"
                className="w-14 rounded-lg border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-line"
              />
              <input
                aria-label={`Player ${i + 1} date of birth`}
                type="date"
                value={p.dob}
                onChange={(e) =>
                  setPlayers((ps) => ps.map((x, j) => (j === i ? { ...x, dob: e.target.value } : x)))
                }
                className="rounded-lg border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-line"
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
        onClick={() =>
          setPlayers((ps) => (ps.length < 50 ? [...ps, { name: "", dob: "", squad_number: "" }] : ps))
        }
        className="rounded-lg border border-accent-line bg-white px-3 py-1.5 text-sm font-medium text-accent-strong hover:bg-accent-soft"
      >
        + Add player
      </button>

      <details className="text-sm">
        <summary className="cursor-pointer text-accent-strong">Import a list</summary>
        <p className="mt-2 text-xs text-zinc-500">
          One player per line. Optional squad number and date of birth (YYYY-MM-DD), comma-separated
          — e.g. <code>Jordan Blake, 7, 2005-04-12</code>.
        </p>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={4}
          placeholder={"Jordan Blake, 7\nSam Ortiz, 10, 2004-11-30\nAlex Kim"}
          className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-line"
        />
        <button
          type="button"
          onClick={() => {
            const parsed = parseRoster(importText);
            if (parsed.length === 0) return;
            setPlayers((ps) => [...ps, ...parsed].slice(0, 50));
            setImportText("");
          }}
          className="mt-2 rounded-lg border border-accent-line bg-white px-3 py-1.5 text-sm font-medium text-accent-strong hover:bg-accent-soft"
        >
          Add {parseRoster(importText).length || ""} players from list
        </button>
      </details>
    </fieldset>
  );
}
