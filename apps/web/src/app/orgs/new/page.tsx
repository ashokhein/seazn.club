export const dynamic = "force-dynamic";
import Link from "next/link";
import { BackLink } from "@/components/back-link";
import { redirect } from "next/navigation";
import { getCurrentUser, getUserOrgs } from "@/lib/auth";
import { Nav } from "@/components/nav";
import { CreateOrgForm } from "@/components/create-org-form";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function NewOrgPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const orgs = await getUserOrgs(user.id);
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <main className="mx-auto max-w-md px-4 py-10">
        {orgs.length > 0 && <BackLink href="/dashboard" label={t(ui, "common.dashboard")} />}
        <div className="mb-6 text-center">
          <h1 className="page-title">
            {t(ui, "orgNew.title")}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {t(ui, "orgNew.subtitle")}
          </p>
        </div>
        <CreateOrgForm />
        {orgs.length > 0 && (
          <p className="mt-4 text-center text-sm text-slate-500">
            {t(ui, "orgNew.alreadyHave")}{" "}
            <Link href="/dashboard" className="text-purple-700 hover:underline">
              {t(ui, "orgNew.goToBoard")}
            </Link>
          </p>
        )}
      </main>
    </DictProvider>
  );
}
