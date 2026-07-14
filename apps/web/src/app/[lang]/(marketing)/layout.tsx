import { notFound } from "next/navigation";
import { LOCALES, hasLocale } from "@/lib/i18n-constants";
import { HtmlLang } from "@/components/i18n/html-lang";

// Static per-locale prerender (v5 i18n §5). Only en/fr/es/nl are built; any
// other [lang] value 404s via hasLocale below.
export function generateStaticParams() {
  return LOCALES.map((lang) => ({ lang }));
}

export default async function MarketingLangLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  return (
    <>
      <HtmlLang lang={lang} />
      {children}
    </>
  );
}
