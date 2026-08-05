export const dynamic = "force-dynamic";
// Division builder: sport → variant → eligibility → stage graph (PROMPT-15).
import { redirect } from "next/navigation";
import { requireCompetitionPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { getCompetition } from "@/server/usecases/competitions";
import { withTenant } from "@/lib/db";
import { hasFeature } from "@/lib/entitlements";
import { archivedSlotsExplainRefusal } from "@/server/usecases/division-slots";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";

export default async function NewDivisionPage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  const page = await requireCompetitionPage(orgSlug, compSlug, { tail: "/d/new" });
  const { auth, canEdit } = page;
  const id = page.competition.id;
  if (!canEdit) redirect(routes.competition(orgSlug, compSlug));
  const [competition, constraintsAllowed, explainArchivedSlots] = await Promise.all([
    getCompetition(auth, id),
    // A multi-venue schedule seed is Pro (doc 12 §5) — gate the list in the
    // wizard rather than letting the settings PUT 402 after create.
    hasFeature(auth.orgId, "scheduling.constraints"),
    // Read UNCONDITIONALLY, before anyone has been refused anything: this page
    // is the only surface that creates a division, so it is the only place the
    // `divisions.per_competition.max` 402 can land, and the refusal happens in
    // a client component after a POST that this server render is already over.
    // Fetching it here costs one count on every wizard load — a second count
    // and a cached entitlement read only when something IS archived — and it
    // keeps the rule on the server; asking for it after the 402 would need a
    // new endpoint exposing the quota predicate to the browser.
    archivedSlotsExplainRefusal(auth, id),
  ]);

  // Sport catalog + variant presets (system rows are tenant-readable, org
  // presets scoped by RLS — doc 07).
  const sports = await withTenant(auth.orgId, async (tx) => {
    const sportRows = await tx<{ key: string; name: string }[]>`
      select key, name from sports order by name`;
    const variantRows = await tx<
      { sport_key: string; key: string; name: string; is_system: boolean }[]
    >`
      select sport_key, key, name, is_system from sport_variants
      order by is_system desc, name`;
    return sportRows.map((s): SportOption => ({
      key: s.key,
      name: s.name,
      variants: variantRows
        .filter((v) => v.sport_key === s.key)
        .map((v) => ({ key: v.key, name: v.name, system: v.is_system })),
    }));
  });

  return (
    <>
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">
          New division
        </h1>
        <p className="mb-6 text-sm text-slate-500">
          in <span className="font-medium">{competition.name}</span>
        </p>
        <DivisionBuilder
          competitionId={id}
          orgSlug={orgSlug}
          compSlug={compSlug}
          sports={sports}
          constraintsAllowed={constraintsAllowed}
          archivedSlotsExplainRefusal={explainArchivedSlots}
        />
      </main>
    </>
  );
}
