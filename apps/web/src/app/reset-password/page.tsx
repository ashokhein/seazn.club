import { ResetPasswordForm } from "@/components/reset-password-form";
import { NightStage } from "@/components/night-stage";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  return (
    <NightStage maxW="max-w-md">
      <DictProvider dict={ui} locale={locale}>
        <ResetPasswordForm token={token ?? null} />
      </DictProvider>
    </NightStage>
  );
}
