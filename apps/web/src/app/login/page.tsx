import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { AuthForm } from "@/components/auth-form";
import { NightStage } from "@/components/night-stage";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/dashboard");
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  return (
    <NightStage>
      <DictProvider dict={ui} locale={locale}>
        <p className="-mt-3 mb-6 text-center text-sm text-cream/70">
          {t(ui, "login.subtitle")}
        </p>
        <AuthForm />
      </DictProvider>
    </NightStage>
  );
}
