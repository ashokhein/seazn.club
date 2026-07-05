export const dynamic = "force-dynamic";
// Division builder: sport → variant → eligibility → stage graph (PROMPT-15).
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { withTenant } from "@/lib/db";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";

export default async function NewDivisionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth, canEdit } = await requireResourcePageAuth("competition", id);
  if (!canEdit) redirect(`/competitions/${id}`);
  const competition = await getCompetition(auth, id);

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
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-xl font-semibold tracking-tight text-slate-900">
          New division
        </h1>
        <p className="mb-6 text-sm text-slate-500">
          in <span className="font-medium">{competition.name}</span>
        </p>
        <DivisionBuilder competitionId={id} sports={sports} />
      </main>
    </>
  );
}
