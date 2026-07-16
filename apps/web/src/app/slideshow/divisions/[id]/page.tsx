export const dynamic = "force-dynamic";
// Per-division noticeboard slideshow — standings, live fixtures, results.
// Pro orgs (dashboard.branding) get the board tinted with their brand color,
// same resolver as the public courtside pages.
import { requireResourcePageAuth } from "@/server/page-auth";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { routes } from "@/lib/routes";
import { buildDivisionSlides, orgBoardChrome } from "@/server/slideshow-data";
import { hasFeature } from "@/lib/entitlements";
import { publicThemeStyleChain } from "@/lib/public-theme";
import { resolveSponsors } from "@/server/usecases/sponsors";
import { Slideshow } from "@/components/v2/slideshow";

export default async function DivisionSlideshowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth, org } = await requireResourcePageAuth("division", id);
  const division = await getDivision(auth, id);
  const competition = await getCompetition(auth, division.competition_id);
  const [slides, realtime, chrome] = await Promise.all([
    buildDivisionSlides(auth, id, division.name),
    hasFeature(auth.orgId, "realtime"),
    orgBoardChrome(auth),
  ]);

  return (
    <Slideshow
      title={`${competition.name} · ${division.name}`}
      slides={slides}
      backHref={routes.division(org.slug, competition.slug, division.slug)}
      divisionIds={[id]}
      realtime={realtime}
      // competition.branding comes off the console read model (NOT emptied
      // in-query like the public views) — gate it on the same entitlement,
      // or a Community board leaks the brand color (smoke: "community
      // slideshow keeps default theme").
      themeStyle={publicThemeStyleChain(
        chrome.themed ? competition.branding : null,
        chrome.branding,
      )}
      logo={chrome.logo}
      // v10: resolver rows scoped to this division's competition, blob shim
      // fallback for un-backfilled orgs.
      sponsors={await resolveSponsors(auth.orgId, division.competition_id)}
    />
  );
}
