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

  const url = `https://seazn.club/${org.slug}/${competition.slug}`;
  const qr = await QRCode.toDataURL(url, { width: 480, margin: 1 });

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 py-8 text-center">
      <h1 className="text-3xl font-bold">{competition.name}</h1>
      <p className="text-lg text-zinc-600">{org.name}</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qr} alt={`QR code for ${url}`} className="h-72 w-72" />
      <p className="text-xl font-medium">Scan for live scores, fixtures & standings</p>
      <p className="text-sm text-zinc-500">{url}</p>
      <PrintButton />
    </div>
  );
}
