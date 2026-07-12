export const dynamic = "force-dynamic";
// Public registration status by reference (v3/05 §3, PROMPT-34): /r/SZ-….
// The ref is a lookup, not auth — this shows nothing beyond the success
// screen, and self-withdraw still needs the emailed token (?token=). Doubles
// as the organiser's day-of check-in lookup.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import QRCode from "qrcode";
import {
  publicRegistrationStatusByRef,
  reconcileRegistrationBySession,
} from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { TearOffTicket } from "@/components/public-site/ticket";
import { WithdrawByRef } from "@/components/public-site/withdraw-by-ref";
import { ShareButton } from "@/components/share-button";
import { baseUrlFromHeaders } from "@/lib/base-url";

export const metadata: Metadata = { robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ ref: string }>;
  searchParams: Promise<{ token?: string; checkout?: string; session_id?: string }>;
};

const STATUS_LINE: Record<string, string> = {
  pending: "Registration received — pending review.",
  paid: "Payment received — confirmation is being finalised.",
  confirmed: "Confirmed — on the entrant list.",
  waitlisted: "On the waitlist — promoted automatically if a spot opens.",
  withdrawn: "This registration has been withdrawn.",
  expired: "The pay window passed — this registration expired. Register again if spots remain.",
};

export default async function RefStatusPage({ params, searchParams }: Props) {
  const [{ ref }, { token, checkout, session_id }] = await Promise.all([params, searchParams]);
  const refCode = decodeURIComponent(ref);
  // Token-free checkout return (email-minted sessions): reconcile before the
  // read so the paid state shows even ahead of the webhook. Best-effort.
  if (checkout === "success" && session_id) {
    await reconcileRegistrationBySession(refCode, session_id);
  }
  let view;
  try {
    view = await publicRegistrationStatusByRef(refCode, token ?? null);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }

  const origin = await baseUrlFromHeaders();
  const statusUrl = `${origin}/r/${view.ref_code}`;
  const qrDataUrl = await QRCode.toDataURL(statusUrl, { margin: 1, width: 224 });
  const divisionHref = `/shared/${view.org_slug}/${view.competition_slug}/${view.division_slug}`;

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <p className="text-sm text-ink-muted" data-testid="ref-status-line">
        {STATUS_LINE[view.status] ?? STATUS_LINE.pending}
      </p>
      <div className="mt-4">
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
          actions={
            <>
              <Link
                href={divisionHref}
                className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500"
              >
                View the live dashboard
              </Link>
              {/* v3/10 #2 — "I'm in!" straight to the family group chat. */}
              <ShareButton
                title={view.competition_name}
                text={`I'm registered for ${view.division_name} at ${view.competition_name} (ref ${view.ref_code}). Follow it live:`}
                url={divisionHref}
                className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-4 py-2 text-sm hover:border-zinc-500"
              />
              {view.can_withdraw && token && (
                <WithdrawByRef refCode={view.ref_code} token={token} />
              )}
            </>
          }
        />
      </div>
    </main>
  );
}
