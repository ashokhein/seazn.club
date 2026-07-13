// The tear-off ticket (v3/05 §3 — "the page is a ticket, not a form").
// Sports registration's native artifact is the entry ticket: event masthead
// up top, a perforated tear line, and the stub carrying the huge mono
// reference + QR. Server component — the QR arrives as a data URL.
import { msg } from "@/lib/messages";

const STATUS_STAMP: Record<string, { label: string; tone: string }> = {
  pending: { label: "RECEIVED", tone: "text-amber-700 border-amber-400" },
  paid: { label: "PAID", tone: "text-emerald-700 border-emerald-400" },
  confirmed: { label: "CONFIRMED", tone: "text-emerald-700 border-emerald-400" },
  waitlisted: { label: "WAITLIST", tone: "text-sky-700 border-sky-400" },
  withdrawn: { label: "WITHDRAWN", tone: "text-zinc-500 border-zinc-300" },
};

export function TearOffTicket({
  refCode,
  status,
  displayName,
  divisionName,
  competitionName,
  orgName,
  startsOn,
  endsOn,
  qrDataUrl,
  actions,
}: {
  refCode: string | null;
  status: string;
  displayName: string;
  divisionName: string;
  competitionName: string;
  orgName: string;
  startsOn: string | null;
  endsOn: string | null;
  /** QR encoding the /r/[ref] status URL; null when the row predates refs. */
  qrDataUrl: string | null;
  /** Buttons row rendered under the stub (calendar / save / withdraw). */
  actions?: React.ReactNode;
}) {
  const stamp = STATUS_STAMP[status] ?? STATUS_STAMP.pending!;
  const dates = startsOn
    ? `${startsOn}${endsOn && endsOn !== startsOn ? ` – ${endsOn}` : ""}`
    : null;

  return (
    <div className="relative">
      <article
        className="overflow-hidden rounded-2xl border border-zinc-300 bg-surface shadow-sm"
        aria-label="Registration ticket"
      >
        {/* Masthead */}
        <header className="border-b border-zinc-200 px-6 py-5">
          <p className="text-xs tracking-widest text-ink-muted uppercase">{orgName}</p>
          <h2 className="mt-0.5 font-display text-3xl leading-none font-bold tracking-tight text-ink uppercase">
            {competitionName}
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            {divisionName}
            {dates ? ` · ${dates}` : ""}
          </p>
        </header>

        {/* Holder + stamp */}
        <div className="flex items-center justify-between gap-4 px-6 py-4">
          <div className="min-w-0">
            <p className="text-[11px] tracking-widest text-ink-muted uppercase">Entrant</p>
            <p className="truncate text-lg font-semibold text-ink">{displayName}</p>
          </div>
          <span
            className={`shrink-0 -rotate-6 rounded border-2 px-2.5 py-1 font-display text-lg font-bold tracking-widest ${stamp.tone}`}
            aria-label={`Status: ${status}`}
          >
            {stamp.label}
          </span>
        </div>

        {/* Perforation: the tear line between ticket and stub */}
        <div className="relative" aria-hidden>
          <div className="border-t-2 border-dashed border-zinc-300" />
          <span className="absolute top-1/2 -left-3 h-6 w-6 -translate-y-1/2 rounded-full border border-zinc-300 bg-canvas" />
          <span className="absolute top-1/2 -right-3 h-6 w-6 -translate-y-1/2 rounded-full border border-zinc-300 bg-canvas" />
        </div>

        {/* Stub: huge mono ref + QR */}
        <div className="flex flex-wrap items-center gap-5 px-6 py-5">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] tracking-widest text-ink-muted uppercase">
              {msg("register.ticket.refLabel")}
            </p>
            {refCode ? (
              <p
                data-testid="ref-code"
                className="mt-1 font-mono text-3xl font-bold tracking-[0.08em] break-all text-ink sm:text-4xl"
              >
                {refCode}
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">
                Issued before reference numbers — your email link is your receipt.
              </p>
            )}
            <p className="mt-2 max-w-md text-xs text-ink-muted">{msg("register.ticket.keep")}</p>
          </div>
          {qrDataUrl && (
            /* data: URI QR code — generated in-memory, not storage-served; next/image
               optimizer doesn't apply, stays <img> */
            /* eslint-disable-next-line @next/next/no-img-element -- data URL QR */
            <img
              src={qrDataUrl}
              alt={`QR code for your registration status page${refCode ? ` (${refCode})` : ""}`}
              width={112}
              height={112}
              className="rounded-lg border border-zinc-200 bg-white p-1.5"
            />
          )}
        </div>
      </article>

      {actions && <div className="mt-4 flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
