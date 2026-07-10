export const dynamic = "force-dynamic";
// Competition-wide noticeboard slideshow — rotates through every division
// that has something to show (active divisions first). Pro orgs
// (dashboard.branding) get the board tinted with their brand color, same
// resolver as the public courtside pages.
import { requireResourcePageAuth } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { listDivisions } from "@/server/usecases/divisions";
import { buildDivisionSlides, orgBoardChrome, type Slide } from "@/server/slideshow-data";
import { hasFeature } from "@/lib/entitlements";
import { publicThemeStyleChain } from "@/lib/public-theme";
import { Slideshow } from "@/components/v2/slideshow";

export default async function CompetitionSlideshowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth } = await requireResourcePageAuth("competition", id);
  const [competition, divisions] = await Promise.all([
    getCompetition(auth, id),
    listDivisions(auth, id),
  ]);

  // Active divisions lead; the rest follow so a finished division's final
  // table still cycles through.
  const ordered = [...divisions].sort(
    (a, b) => Number(b.status === "active") - Number(a.status === "active"),
  );
  // Sequential on purpose: parallel decks × parallel queries inside each deck
  // can exhaust the small pg pool through the Supabase pooler.
  const slides: Slide[] = [];
  for (const d of ordered) {
    slides.push(...(await buildDivisionSlides(auth, d.id, d.name)));
  }
  const [realtime, chrome] = await Promise.all([
    hasFeature(auth.orgId, "realtime"),
    orgBoardChrome(auth),
  ]);

  return (
    <Slideshow
      title={competition.name}
      slides={slides}
      backHref={`/competitions/${id}`}
      divisionIds={ordered.map((d) => d.id)}
      realtime={realtime}
      // Same gate as the division board: console reads don't empty branding,
      // so the entitlement check happens here.
      themeStyle={publicThemeStyleChain(
        chrome.themed ? competition.branding : null,
        chrome.branding,
      )}
      logo={chrome.logo}
    />
  );
}
