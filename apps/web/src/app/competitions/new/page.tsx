export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { CompetitionWizard } from "@/components/v2/competition-wizard";

export default async function NewCompetitionPage() {
  const { canEdit } = await requirePageAuth();
  if (!canEdit) redirect("/dashboard");

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="mb-6 text-xl font-semibold tracking-tight text-slate-900">
          New competition
        </h1>
        <CompetitionWizard />
      </main>
    </>
  );
}
