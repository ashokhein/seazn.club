export const dynamic = "force-dynamic";
// Organiser registration console (doc 16 §1.1, PROMPT-20a item 4).
import { requireDivisionPage } from "@/server/page-auth";
import { hasFeature } from "@/lib/entitlements";
import { sql } from "@/lib/db";
import { getDivision } from "@/server/usecases/divisions";
import { getCompetition } from "@/server/usecases/competitions";
import { RegistrationsPanel } from "@/components/v2/registrations-panel";
import { CopyLink } from "@/components/copy-link";

export default async function DivisionRegistrationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; compSlug: string; divSlug: string }>;
}) {
  const { orgSlug, compSlug, divSlug } = await params;
  const page = await requireDivisionPage(orgSlug, compSlug, divSlug, {
    tail: "/registrations",
  });
  const { auth, canEdit } = page;
  const id = page.division.id;
  const division = await getDivision(auth, id);
  const competition = await getCompetition(auth, division.competition_id);
  const [org] = await sql<{ slug: string; charges_enabled: boolean }[]>`
    select slug, stripe_charges_enabled as charges_enabled
    from organizations where id = ${auth.orgId}`;
  // Offline (cash/bank) fees are free on every plan; only online (Stripe) fees
  // need Pro. So the fee field is unlocked whenever charges aren't enabled.
  const paidAllowed = org.charges_enabled
    ? await hasFeature(auth.orgId, "registration.paid")
    : true;
  // Public registration is a per-competition page; only public/unlisted comps
  // are reachable without a login.
  const registerUrl =
    competition.visibility !== "private"
      ? `/shared/${org.slug}/${competition.slug}/register`
      : null;

  return (
    <>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-6">
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">
            Registrations — {division.name}
          </h1>
        </div>

        {registerUrl ? (
          <div className="mb-6 rounded-lg border border-purple-100 bg-purple-50/40 p-4">
            <p className="text-sm font-medium text-slate-800">Public registration link</p>
            <p className="mt-0.5 text-xs text-slate-500">
              Share this with entrants — it opens the register form for {competition.name}.
            </p>
            <div className="mt-2">
              <CopyLink path={registerUrl} />
            </div>
          </div>
        ) : (
          <p className="mb-6 rounded-lg border border-amber-100 bg-amber-50 p-3 text-xs text-amber-800">
            This competition is private, so it has no public registration link. Set it to
            unlisted or public in competition settings to share one.
          </p>
        )}

        <RegistrationsPanel
          divisionId={id}
          canEdit={canEdit && !(competition.frozen ?? false)}
          paidAllowed={paidAllowed}
        />
      </main>
    </>
  );
}
