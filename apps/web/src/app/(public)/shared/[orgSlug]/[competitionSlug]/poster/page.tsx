// Printable QR poster per competition (doc 09 §1) — scan to open the public
// dashboard. QR rendered server-side with the existing `qrcode` dependency.
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import QRCode from "qrcode";
import { getPublicCompetition } from "@/server/public-site/data";
import { PrintButton } from "@/components/print-button";

export const revalidate = 300;

// ISR (task-8): empty-array generateStaticParams is required for on-demand
// ISR on a dynamic segment in this Next version — see generate-static-params.md.
export async function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

export const metadata: Metadata = {
  robots: { index: false, follow: false }, // a print artefact, not a landing page
};

export default async function PosterPage({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  const data = await getPublicCompetition(orgSlug, competitionSlug);
  if (!data) notFound();
  const { org, competition } = data;

  const url = `https://seazn.club/shared/${org.slug}/${competition.slug}`;
  const qr = await QRCode.toDataURL(url, { width: 480, margin: 1 });

  return (
    <div className="mx-auto max-w-xl py-8">
      <div className="overflow-hidden rounded-3xl border-4 border-accent bg-surface text-center shadow-xl print:border-2 print:shadow-none">
        <div className="bg-court px-8 py-6 text-court-ink">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-court-muted">
            {org.name}
          </p>
          <h1 className="mt-1 font-display text-4xl font-bold uppercase tracking-tight">
            {competition.name}
          </h1>
        </div>
        <div aria-hidden className="h-1 bg-accent" />
        <div className="flex flex-col items-center gap-5 px-8 py-8">
          <div className="rounded-2xl border border-zinc-200 p-3 shadow-sm">
            {/* data: URI QR code — generated in-memory, not storage-served; next/image
                optimizer doesn't apply, stays <img> */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={`QR code for ${url}`} className="h-72 w-72" />
          </div>
          <p className="font-display text-3xl font-semibold text-ink">
            Scan for live scores, fixtures & standings
          </p>
          <p className="rounded-full bg-accent-soft px-4 py-1.5 text-sm font-medium text-accent-strong">
            {url}
          </p>
        </div>
      </div>
      <div className="mt-6 text-center print:hidden">
        <PrintButton />
      </div>
    </div>
  );
}
