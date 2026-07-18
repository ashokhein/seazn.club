export const revalidate = 30;
// Public presentation mode — division (v13/PROMPT-64): a no-login, shareable
// kiosk URL an organiser points a venue screen at. Reuses the noticeboard
// <Slideshow> with slides built from the PUBLIC read models (consent and
// visibility enforced by the public_* views); a private competition 404s.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicDivision } from "@/server/public-site/data";
import { buildPublicDivisionSlides } from "@/server/slideshow-data";
import { Slideshow } from "@/components/v2/slideshow";
import { publicThemeStyle } from "@/lib/public-theme";

// Kiosk duplicate of the public division page — never indexed.
export const metadata: Metadata = { robots: { index: false } };

export default async function PresentDivisionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; competitionSlug: string; divisionSlug: string }>;
}) {
  const { orgSlug, competitionSlug, divisionSlug } = await params;
  const data = await getPublicDivision(orgSlug, competitionSlug, divisionSlug);
  if (!data) notFound();
  const slides = buildPublicDivisionSlides(data);
  return (
    <Slideshow
      title={`${data.competition.name} · ${data.division.name}`}
      slides={slides}
      backHref={`/shared/${orgSlug}/${competitionSlug}/${divisionSlug}`}
      themeStyle={publicThemeStyle(data.competition.branding)}
    />
  );
}
