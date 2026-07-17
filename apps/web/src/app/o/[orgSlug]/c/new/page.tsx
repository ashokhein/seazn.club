export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { CompetitionWizard } from "@/components/v2/competition-wizard";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";

export default async function NewCompetitionPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { canEdit } = await requireOrgPage(orgSlug);
  if (!canEdit) redirect(routes.orgHome(orgSlug));
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  return (
    <main className="mx-auto max-w-2xl px-4 py-8" data-tour="competition-wizard">
      <h1 className="mb-6 text-xl font-semibold tracking-tight text-slate-900">
        {t(dict, "comp.new.title")}
      </h1>
      <CompetitionWizard orgSlug={orgSlug} />
    </main>
  );
}
