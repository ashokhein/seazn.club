export const dynamic = "force-dynamic";
// Registration success / status page (PROMPT-20a item 3, rebuilt as the
// tear-off ticket per v3/05 §3; payment strip per spec 2026-07-12 §8). The URL
// carries the registration id + one-time access token — this page IS the
// registrant's receipt (no account). Returning from Stripe with
// ?checkout=success runs the reconcile-on-return so the paid state shows even
// before the webhook lands.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import QRCode from "qrcode";
import {
  publicRegistrationStatus,
  reconcileRegistration,
} from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { baseUrlFromHeaders } from "@/lib/base-url";
import { renderProse } from "@/lib/prose";
import { fillPaymentInstructions } from "@/lib/payment-instructions";
import { CompetitionProse } from "@/components/public-site/competition-prose";
import { TearOffTicket } from "@/components/public-site/ticket";
import { RegistrationActions } from "@/components/public-site/registration-actions";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, type Dict } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
  searchParams: Promise<{ rid?: string; token?: string; checkout?: string }>;
};

// Copy keys resolve against the ui catalog per request; tone stays inline.
const STATUS_COPY: Record<string, { key: string; tone: string }> = {
  pending: { key: "status.pending", tone: "border-amber-200 bg-amber-50 text-amber-800" },
  pending_card: { key: "status.pending_card", tone: "border-amber-200 bg-amber-50 text-amber-800" },
  paid: { key: "status.paid", tone: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  confirmed: { key: "status.confirmed", tone: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  waitlisted: { key: "status.waitlisted", tone: "border-sky-200 bg-sky-50 text-sky-800" },
  withdrawn: { key: "status.withdrawn", tone: "border-zinc-200 bg-zinc-50 text-zinc-600" },
  expired: { key: "status.expired", tone: "border-zinc-200 bg-zinc-50 text-zinc-600" },
};

function formatDeadlineUtc(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
  });
}

function money(cents: number, currency: string | null): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: (currency ?? "gbp").toUpperCase(),
  }).format(cents / 100);
}

/** Submitted → Payment → Confirmed strip: the whole journey at a glance. */
function Timeline({ status, paid, ui }: { status: string; paid: boolean; ui: Dict }) {
  const stages: { label: string; state: "done" | "now" | "todo" | "off" }[] = [
    { label: t(ui, "status.timeline.submitted"), state: "done" },
    {
      label: t(ui, "status.timeline.payment"),
      state: !paid
        ? "off"
        : status === "confirmed" || status === "paid"
          ? "done"
          : status === "pending"
            ? "now"
            : "todo",
    },
    {
      label: t(ui, "status.timeline.confirmed"),
      state: status === "confirmed" ? "done" : status === "paid" ? "now" : "todo",
    },
  ];
  const dot: Record<string, string> = {
    done: "bg-emerald-500",
    now: "bg-amber-400 ring-4 ring-amber-100",
    todo: "bg-zinc-300",
    off: "bg-zinc-200",
  };
  const shown = stages.filter((s) => s.state !== "off");
  if (["withdrawn", "expired", "waitlisted"].includes(status)) return null;
  return (
    <ol className="mt-4 flex items-center gap-0" aria-label="Registration progress">
      {shown.map((s, i) => (
        <li key={s.label} className="flex flex-1 items-center last:flex-none">
          <span className="flex flex-col items-center gap-1">
            <span aria-hidden className={`h-2.5 w-2.5 rounded-full ${dot[s.state]}`} />
            <span
              className={`text-[11px] uppercase tracking-wide ${
                s.state === "todo" ? "text-zinc-400" : "text-zinc-700"
              }`}
            >
              {s.label}
            </span>
          </span>
          {i < shown.length - 1 && (
            <span aria-hidden className="mx-2 mb-4 h-px flex-1 bg-zinc-200" />
          )}
        </li>
      ))}
    </ol>
  );
}

export default async function RegistrationStatusPage({ params, searchParams }: Props) {
  const [{ orgSlug, competitionSlug }, { rid, token, checkout }] = await Promise.all([
    params,
    searchParams,
  ]);
  if (!rid || !token) notFound();

  if (checkout === "success") {
    await reconcileRegistration(rid, token); // best-effort, never throws
  }
  let view;
  try {
    view = await publicRegistrationStatus(rid, token);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const copyKey =
    view.status === "pending" && view.can_pay_online ? "pending_card" : view.status;
  const copy = STATUS_COPY[copyKey] ?? STATUS_COPY.pending!;
  const icsHref = `/api/v1/public/registrations/${view.id}/ics?token=${encodeURIComponent(token)}`;
  const origin = await baseUrlFromHeaders();
  const qrDataUrl = view.ref_code
    ? await QRCode.toDataURL(`${origin}/r/${view.ref_code}`, { margin: 1, width: 224 })
    : null;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
    <div className="mx-auto max-w-xl">
      <p className="text-xs text-ink-muted">
        <Link
          href={`/shared/${orgSlug}/${competitionSlug}`}
          className="hover:text-accent-strong hover:underline"
        >
          {view.competition_name}
        </Link>{" "}
        / {t(ui, "status.breadcrumb")}
      </p>

      <div className={`mt-3 rounded-xl border p-5 ${copy.tone}`}>
        <h1 className="font-display text-2xl font-semibold">{t(ui, `${copy.key}.title`)}</h1>
        <p className="mt-1 text-sm">{t(ui, `${copy.key}.body`)}</p>
        {view.status === "waitlisted" && view.position !== null && (
          <p
            className="mt-2 inline-block rounded-md bg-white/70 px-2.5 py-1 text-xs font-semibold tabular-nums"
            data-testid="queue-position-public"
          >
            {t(ui, "status.waitlistPosition", { n: view.position })}
          </p>
        )}
        {view.status === "pending" && view.can_pay_online && view.expires_at && (
          <p className="mt-2 inline-block rounded-md bg-white/70 px-2.5 py-1 text-xs font-semibold tabular-nums">
            {t(ui, "status.spotHeld", { deadline: formatDeadlineUtc(view.expires_at) })}
          </p>
        )}
        <Timeline status={view.status} paid={view.amount_cents > 0 || view.fee_cents > 0} ui={ui} />
      </div>

      {/* The tear-off ticket (v3/05 §3): masthead, entrant, huge mono ref,
          QR to the public status page. */}
      <div className="mt-5">
        <TearOffTicket
          refCode={view.ref_code}
          status={view.status}
          displayName={view.display_name}
          divisionName={view.division_name}
          competitionName={view.competition_name}
          orgName={view.org_name}
          startsOn={view.starts_on}
          endsOn={view.ends_on}
          qrDataUrl={qrDataUrl}
          locale={locale}
          actions={
            <>
              {(view.status === "confirmed" || view.status === "paid") && (
                <a
                  href={icsHref}
                  className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500"
                >
                  {t(ui, "register.ticket.calendar")}
                </a>
              )}
              {view.ref_code && (
                <a
                  href={`/r/${view.ref_code}/ticket.png`}
                  download={`${view.ref_code}.png`}
                  className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500"
                >
                  {t(ui, "register.ticket.save")}
                </a>
              )}
              {view.ref_code && (
                <Link
                  href={`/r/${view.ref_code}`}
                  className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500"
                >
                  {t(ui, "register.ticket.status")}
                </Link>
              )}
              <RegistrationActions
                registrationId={view.id}
                token={token}
                status={view.status}
                paymentDue={view.can_pay_online}
                payLabel={t(ui, "status.payLabel", { amount: money(view.amount_cents, view.currency) })}
              />
            </>
          }
        />
      </div>

      {view.amount_cents > 0 && (
        <p className="mt-4 text-sm text-zinc-600">
          {t(ui, "status.entryFee")} <strong>{money(view.amount_cents, view.currency)}</strong>
          {view.refunded_cents > 0
            ? ` ${t(ui, "status.refunded", { amount: money(view.refunded_cents, view.currency) })}`
            : ""}
        </p>
      )}

      {view.payment_due && view.payment_method !== "stripe" && (
        <div className="mt-4 rounded-xl border border-accent-line bg-accent-soft p-5">
          <h2 className="text-sm font-semibold text-accent-strong">{t(ui, "status.howToPay")}</h2>
          {view.payment_instructions ? (
            /* Markdown through the one prose pipeline; {{reference}} becomes
               this registrant's ref code. */
            <div className="mt-2 text-sm text-zinc-700">
              <CompetitionProse
                html={await renderProse(
                  fillPaymentInstructions(view.payment_instructions, view.ref_code),
                )}
              />
            </div>
          ) : (
            <p className="mt-2 text-sm text-zinc-600">
              {t(ui, "status.contactYou")}
            </p>
          )}
          <p className="mt-3 text-xs text-zinc-500">
            {t(ui, "status.confirmsOnce")}
          </p>
        </div>
      )}

      {view.payment_due && view.payment_method === "stripe" && !view.can_pay_online && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-5 text-sm text-zinc-600">
          {t(ui, "status.cardUnavailable")}
        </div>
      )}

      <p className="mt-6 text-xs text-zinc-500">
        {t(ui, "status.keepLink")}
      </p>
    </div>
    </DictProvider>
  );
}
