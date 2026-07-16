export const dynamic = "force-dynamic";
// Public register flow (doc 16 §1.1, PROMPT-20a item 3): division picker →
// eligibility-aware form (DOB + guardian consent for minors) → pay →
// confirmation. Uncached — remaining capacity is live.
import Link from "next/link";
import { notFound } from "next/navigation";
import Image from "next/image";
import type { Metadata } from "next";
import { publicRegistrationInfo } from "@/server/usecases/registrations";
import { getPublicOrg } from "@/server/public-site/data";
import { brandingSponsors } from "@/lib/org-branding";
import { HttpError } from "@/lib/errors";
import { RegisterForm } from "@/components/public-site/register-form";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t, toLocale } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function RegisterPage({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  let info;
  try {
    info = await publicRegistrationInfo(orgSlug, competitionSlug);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  // Org sponsors, entitlement-gated by the public org read (v3/10 #5).
  const pub = await getPublicOrg(orgSlug);
  const sponsors = brandingSponsors(pub?.org.branding);

  const locale = await resolveLocale({ orgDefault: toLocale(pub?.org.default_locale ?? null) });
  const ui = await getDictionary(locale, "ui");

  return (
    <DictProvider dict={ui} locale={locale}>
    <div className="mx-auto max-w-2xl">
      <p className="text-xs text-ink-muted">
        <Link
          href={`/shared/${orgSlug}/${competitionSlug}`}
          className="hover:text-accent-strong hover:underline"
        >
          {info.competition.name}
        </Link>{" "}
        / {t(ui, "register.title")}
      </p>
      <h1 className="mt-1 font-display text-4xl font-bold uppercase tracking-tight text-ink">
        {t(ui, "register.title")}
      </h1>
      <p className="mt-1 text-sm text-ink-muted">
        {t(ui, "register.subtitle")}
      </p>
      {/* Sponsor masthead line (v3/10 #5): entitlement-gated upstream. */}
      {sponsors.length > 0 ? (
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span className="font-semibold uppercase tracking-[0.18em]">{t(ui, "register.supportedBy")}</span>
          {sponsors.slice(0, 5).map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              {s.logo ? (
                // sponsor logo — uploaded via content-upload, always a storage URL.
                <Image src={s.logo} alt="" width={16} height={16} className="h-4 w-4 rounded-sm object-contain" />
              ) : null}
              {s.name}
            </span>
          ))}
        </p>
      ) : null}
      {info.divisions.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">
          {t(ui, "register.notOpen")}
        </p>
      ) : (
        <RegisterForm org={info.org} competition={info.competition} divisions={info.divisions} />
      )}
    </div>
    </DictProvider>
  );
}
