export const dynamic = "force-dynamic";
// Per-division noticeboard slideshow — standings, live fixtures, results.
import { requireResourcePageAuth } from "@/server/page-auth";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { buildDivisionSlides } from "@/server/slideshow-data";
import { Slideshow } from "@/components/v2/slideshow";

export default async function DivisionSlideshowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth } = await requireResourcePageAuth("division", id);
  const division = await getDivision(auth, id);
  const competition = await getCompetition(auth, division.competition_id);
  const slides = await buildDivisionSlides(auth, id, division.name);

  return (
    <Slideshow
      title={`${competition.name} · ${division.name}`}
      slides={slides}
      backHref={`/divisions/${id}`}
    />
  );
}
