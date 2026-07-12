export const dynamic = "force-dynamic";
// Bulk participant import wizard (Jul3/01, PROMPT-21): upload → column map →
// preview (the plan, rendered) → commit.
import Link from "next/link";
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { ImportWizard } from "@/components/v2/import-wizard";

export default async function ImportPage() {
  await requirePageAuth();

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6">
          <p className="app-eyebrow mb-1">Bulk add</p>
          <h1 className="page-title">
            Import participants
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Bring clubs, teams and players in from one spreadsheet. Nothing is written
            until you commit the previewed plan. Divisions must{" "}
            <Link href="/dashboard" className="underline">
              exist first
            </Link>{" "}
            — a Division column places each team as an entrant.
          </p>
        </div>
        <ImportWizard />
      </main>
    </>
  );
}
