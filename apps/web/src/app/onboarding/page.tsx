export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { getCurrentUser, resolveActiveOrg } from "@/lib/auth";
import { needsOnboarding } from "@/lib/activation";
import { routes } from "@/lib/routes";
import { sql } from "@/lib/db";
import { Nav } from "@/components/nav";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const org = await resolveActiveOrg(user);
  if (!org) redirect("/orgs/new");
  const already = !(await needsOnboarding(user.id));
  if (already) redirect(routes.orgHome(org.slug));

  // Engine v2 sport catalog (seeded from the module registry by sync:sports).
  const sports = await sql<{ key: string; name: string }[]>`
    select key, name from sports order by name`;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-2xl px-4 py-12">
        <div className="mb-8 text-center">
          <div className="mb-3 text-5xl">🏆</div>
          <h1 className="page-title">
            {t(ui, "onboarding.welcome")}
          </h1>
          <p className="mt-2 text-slate-500">
            {t(ui, "onboarding.subtitle")}
          </p>
        </div>
        <OnboardingWizard sports={sports} orgSlug={org.slug} />
      </main>
    </DictProvider>
  );
}
