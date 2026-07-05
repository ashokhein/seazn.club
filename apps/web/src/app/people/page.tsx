export const dynamic = "force-dynamic";
// Org persons directory (doc 07): persistent people across competitions,
// consent management, dedupe merge.
import { Nav } from "@/components/nav";
import { requirePageAuth } from "@/server/page-auth";
import { listPersons } from "@/server/usecases/persons";
import { PersonsPanel } from "@/components/v2/persons-panel";

export default async function PeoplePage() {
  const { auth, canEdit } = await requirePageAuth();
  const { items } = await listPersons(auth, { cursor: null, limit: 200 });

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">People</h1>
          <p className="mt-1 text-sm text-slate-500">
            Your organisation&apos;s people register — rostered into entrants across
            competitions. Date of birth is used only for eligibility and is never
            shown publicly; names appear on public pages only with consent.
          </p>
        </div>
        <PersonsPanel
          persons={items.map((p) => ({
            id: p.id,
            full_name: p.full_name,
            dob: p.dob,
            gender: p.gender,
            consent: p.consent as { public_name?: boolean; public_photo?: boolean },
            external_ref: p.external_ref,
          }))}
          canEdit={canEdit}
        />
      </main>
    </>
  );
}
