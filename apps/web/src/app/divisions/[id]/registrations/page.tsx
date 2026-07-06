export const dynamic = "force-dynamic";
// Organiser registration console (doc 16 §1.1, PROMPT-20a item 4).
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireResourcePageAuth } from "@/server/page-auth";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { RegistrationsPanel } from "@/components/v2/registrations-panel";

export default async function DivisionRegistrationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { auth, canEdit } = await requireResourcePageAuth("division", id);
  const division = await getDivision(auth, id);
  const competition = await getCompetition(auth, division.competition_id);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6">
          <p className="text-xs text-slate-400">
            <Link href="/dashboard" className="hover:text-purple-600">
              Competitions
            </Link>{" "}
            /{" "}
            <Link href={`/competitions/${competition.id}`} className="hover:text-purple-600">
              {competition.name}
            </Link>{" "}
            /{" "}
            <Link href={`/divisions/${id}`} className="hover:text-purple-600">
              {division.name}
            </Link>
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
            Registrations — {division.name}
          </h1>
        </div>
        <RegistrationsPanel
          orgId={auth.orgId}
          divisionId={id}
          canEdit={canEdit && !(competition.frozen ?? false)}
        />
      </main>
    </>
  );
}
