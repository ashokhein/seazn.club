import { redirect } from "next/navigation";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { sql } from "@/lib/db";
import { listOrgSportPresets } from "@/lib/sport-presets";
import { hasFeature } from "@/lib/entitlements";
import { Nav } from "@/components/nav";
import { NewTournamentForm } from "@/components/new-tournament-form";
import type { Season } from "@/lib/types";

export default async function NewTournamentPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const orgs = await getUserOrgs(user.id);
  if (orgs.length === 0) redirect("/orgs/new");
  const activeId = await getActiveOrgId();
  const active = orgs.find((o) => o.id === activeId) ?? orgs[0];
  if (active.role !== "owner" && active.role !== "admin") redirect("/dashboard");

  const seasons = await sql<Season[]>`
    select id, org_id, name, slug, created_at from seasons
    where org_id = ${active.id} order by created_at asc`;

  const [sportPresets, canUploadImages] = await Promise.all([
    listOrgSportPresets(active.id),
    hasFeature(active.id, "branding"),
  ]);
  const { preset: defaultPresetId } = await searchParams;

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-1 text-2xl font-bold tracking-tight text-purple-900">
          Create a tournament
        </h1>
        <p className="mb-6 text-sm text-slate-500">
          Pick a sport preset from your organization defaults, add players or
          teams, and optionally override scoring or timing for this event only.{" "}
          <a href="/settings" className="text-purple-600 underline">
            Customize presets in Settings
          </a>
          .
        </p>
        <NewTournamentForm
          seasons={seasons}
          presets={sportPresets}
          defaultPresetId={defaultPresetId}
          canUploadImages={canUploadImages}
        />
      </main>
    </>
  );
}
