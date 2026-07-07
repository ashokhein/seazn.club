// Printable QR poster per competition (doc 09 §1) — scan to open the public
// dashboard. QR rendered server-side with the existing `qrcode` dependency.
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import QRCode from "qrcode";
import { getPublicCompetition } from "@/server/public-site/data";
import { PrintButton } from "@/components/print-button";

export const revalidate = 300;

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
      <div className="overflow-hidden rounded-3xl border-4 border-purple-600 bg-white text-center shadow-xl print:border-2 print:shadow-none">
        <div className="bg-gradient-to-r from-purple-700 to-fuchsia-600 px-8 py-6 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-white/70">
            {org.name}
          </p>
          <h1 className="mt-1 text-3xl font-black tracking-tight">{competition.name}</h1>
        </div>
        <div className="flex flex-col items-center gap-5 px-8 py-8">
          <div className="rounded-2xl border border-purple-100 p-3 shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt={`QR code for ${url}`} className="h-72 w-72" />
          </div>
          <p className="text-2xl font-bold text-zinc-900">
            Scan for live scores, fixtures & standings
          </p>
          <p className="rounded-full bg-purple-50 px-4 py-1.5 text-sm font-medium text-purple-700">
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
