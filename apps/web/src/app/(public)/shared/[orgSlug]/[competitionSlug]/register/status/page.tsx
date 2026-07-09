export const dynamic = "force-dynamic";
// Registration confirmation / status page (PROMPT-20a item 3). The URL carries
// the registration id + one-time access token — this page IS the registrant's
// receipt (no account). Returning from Stripe with ?checkout=success runs the
// reconcile-on-return so the paid state shows even before the webhook lands.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  publicRegistrationStatus,
  reconcileRegistration,
} from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { RegistrationActions } from "@/components/public-site/registration-actions";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
  searchParams: Promise<{ rid?: string; token?: string; checkout?: string }>;
};

const STATUS_COPY: Record<string, { title: string; body: string; tone: string }> = {
  pending: {
    title: "Registration received",
    body: "Your spot is held. If an entry fee is due, follow the payment instructions below; the organiser confirms once payment is received.",
    tone: "border-amber-200 bg-amber-50 text-amber-800",
  },
  paid: {
    title: "Payment received",
    body: "Your payment is in — confirmation is being finalised.",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  confirmed: {
    title: "You're in!",
    body: "Your registration is confirmed and you're on the entrant list.",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-800",
  },
  waitlisted: {
    title: "You're on the waitlist",
    body: "The division is full. If a spot opens you'll be promoted automatically — keep this page's link.",
    tone: "border-sky-200 bg-sky-50 text-sky-800",
  },
  withdrawn: {
    title: "Registration withdrawn",
    body: "This registration has been withdrawn.",
    tone: "border-zinc-200 bg-zinc-50 text-zinc-600",
  },
};

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
  const copy = STATUS_COPY[view.status] ?? STATUS_COPY.pending;
  const icsHref = `/api/v1/public/registrations/${view.id}/ics?token=${encodeURIComponent(token)}`;

  return (
    <div className="mx-auto max-w-xl">
      <p className="text-xs text-ink-muted">
        <Link
          href={`/shared/${orgSlug}/${competitionSlug}`}
          className="hover:text-accent-strong hover:underline"
        >
          {view.competition_name}
        </Link>{" "}
        / Registration
      </p>

      <div className={`mt-3 rounded-xl border p-5 ${copy.tone}`}>
        <h1 className="font-display text-2xl font-semibold">{copy.title}</h1>
        <p className="mt-1 text-sm">{copy.body}</p>
      </div>

      <dl className="mt-5 space-y-2 rounded-xl border border-zinc-200/80 bg-surface p-5 text-sm shadow-sm">
        <Row label="Name">{view.display_name}</Row>
        <Row label="Division">{view.division_name}</Row>
        <Row label="Competition">{view.competition_name}</Row>
        {view.starts_on ? (
          <Row label="Dates">
            {view.starts_on}
            {view.ends_on && view.ends_on !== view.starts_on ? ` – ${view.ends_on}` : ""}
          </Row>
        ) : null}
        {view.fee_cents > 0 ? (
          <Row label="Entry fee">
            {new Intl.NumberFormat(undefined, {
              style: "currency",
              currency: (view.currency ?? "gbp").toUpperCase(),
            }).format(view.fee_cents / 100)}
            {view.refunded_cents > 0 ? ` (refunded ${view.refunded_cents / 100})` : ""}
          </Row>
        ) : null}
      </dl>

      {view.payment_due && (
        <div className="mt-5 rounded-xl border border-accent-line bg-accent-soft p-5">
          <h2 className="text-sm font-semibold text-accent-strong">How to pay your entry fee</h2>
          {view.payment_instructions ? (
            <p className="mt-2 whitespace-pre-line text-sm text-zinc-700">
              {view.payment_instructions}
            </p>
          ) : (
            <p className="mt-2 text-sm text-zinc-600">
              The organiser will contact you at your registered email with payment details.
            </p>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {(view.status === "confirmed" || view.status === "paid") && (
          <a href={icsHref} className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500">
            Add to calendar (.ics)
          </a>
        )}
        {/* Stripe checkout disabled — entry fees are paid offline, so no
            online "Pay now" action (paymentDue forced false). */}
        <RegistrationActions
          registrationId={view.id}
          token={token}
          status={view.status}
          paymentDue={false}
        />
      </div>

      <p className="mt-6 text-xs text-zinc-400">
        Keep this page&apos;s link — it&apos;s your receipt and the only way to manage this
        registration.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-zinc-500">{label}</dt>
      <dd className="text-right font-medium text-zinc-800">{children}</dd>
    </div>
  );
}
