export const dynamic = "force-dynamic";
// AI Credits — its own Settings tab (SPEC-6 §A3, moved off the billing page).
// The AI-credit wallet is the ORG's, not the payer's: an org owner inside a
// billing group they don't pay for must still see the pool they spend from, so
// this page is member-visible and NOT payer-gated. The credit-pack purchase +
// CSV export it mounts are session-authed inside their own handlers.
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { BackLink } from "@/components/back-link";
import { BillingCredits } from "@/components/billing-credits";
import { getCreditsTab } from "@/server/usecases/credits-tab";
import { creditPackOptions } from "@/lib/currency";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";

export default async function CreditsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrgPage(orgSlug, { tail: "/settings/credits" });
  const orgId = org.id;
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  // The same credits-only fetch the billing page used to do: the wallet view,
  // the pack ladder priced in the group's locked currency, and the CSV export
  // href (still served by the route under /settings/billing).
  const currency = await preferredCurrency(orgId);
  const creditsView = await getCreditsTab(orgId);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <BackLink
        href={routes.orgSettings(orgSlug)}
        label={t(dict, "action.settings")}
        emphasis="button"
      />
      <div className="mb-6">
        <h1 className="page-title">{t(dict, "settings.nav.credits")}</h1>
      </div>

      <BillingCredits
        view={creditsView}
        dict={dict}
        locale={locale}
        exportHref={`${routes.billing(orgSlug)}/credits.csv`}
        packs={creditPackOptions(currency)}
        currency={currency}
      />
    </main>
  );
}
