import { MagicLink } from "@/components/magic-link";
import { NightStage } from "@/components/night-stage";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function MagicLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; next?: string }>;
}) {
  const { token, next } = await searchParams;
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");
  return (
    <NightStage maxW="max-w-md">
      <DictProvider dict={ui} locale={locale}>
        <MagicLink token={token ?? null} next={next ?? null} />
      </DictProvider>
    </NightStage>
  );
}
