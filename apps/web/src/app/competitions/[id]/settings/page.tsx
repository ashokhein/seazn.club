export const dynamic = "force-dynamic";
// Competition settings — moved off the overview into its own page.
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getCompetition } from "@/server/usecases/competitions";
import { CompetitionSettings } from "@/components/v2/competition-settings";
import { hasFeature } from "@/lib/entitlements";

export default async function CompetitionSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth, org, canEdit } = await requireResourcePageAuth("competition", id);
  const [competition, discoveryBranding] = await Promise.all([
    getCompetition(auth, id),
    hasFeature(auth.orgId, "discovery.branding"),
  ]);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-6">
          <p className="text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-purple-600">
              Competitions
            </Link>{" "}
            / {org.name} /{" "}
            <Link href={`/competitions/${competition.id}`} className="hover:text-purple-600">
              {competition.name}
            </Link>
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
            Settings — {competition.name}
          </h1>
        </div>
        <CompetitionSettings
          competition={{
            id: competition.id,
            name: competition.name,
            slug: competition.slug,
            description: competition.description,
            starts_on: competition.starts_on,
            ends_on: competition.ends_on,
            visibility: competition.visibility,
            status: competition.status,
            frozen: competition.frozen ?? false,
            discoverable: competition.discoverable,
            discovery: (competition.discovery ?? {}) as Record<string, string | null>,
          }}
          canEdit={canEdit}
          discoveryBranding={discoveryBranding}
        />
      </main>
    </>
  );
}
