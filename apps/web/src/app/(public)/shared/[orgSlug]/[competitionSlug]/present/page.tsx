export const revalidate = 30;
// Public presentation mode — competition (v13/PROMPT-64): rotates every
// division's slides (standings / fixtures / live-pinned / bracket) on one
// no-login kiosk URL. Public read models only; private competitions 404.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicCompetition, getPublicDivision } from "@/server/public-site/data";
import { buildPublicDivisionSlides, type Slide } from "@/server/slideshow-data";
import { Slideshow } from "@/components/v2/slideshow";
import { publicThemeStyle } from "@/lib/public-theme";

export const metadata: Metadata = { robots: { index: false } };

export default async function PresentCompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; competitionSlug: string }>;
}) {
  const { orgSlug, competitionSlug } = await params;
  const shell = await getPublicCompetition(orgSlug, competitionSlug);
  if (!shell) notFound();
  const decks = await Promise.all(
    shell.divisions.map(async (d) => {
      const data = await getPublicDivision(orgSlug, competitionSlug, d.slug);
      return data === null ? [] : buildPublicDivisionSlides(data);
    }),
  );
  const slides: Slide[] = decks.flat();
  return (
    <Slideshow
      title={shell.competition.name}
      slides={slides}
      backHref={`/shared/${orgSlug}/${competitionSlug}`}
      themeStyle={publicThemeStyle(shell.competition.branding)}
    />
  );
}
