export const dynamic = "force-dynamic";
// Add-ons — its own Settings tab (v17 gap #293, SPEC-6 §A5).
//
// TODAY THIS TAB HOLDS ONE ROW: extra organisations. SPEC-6 §A5 also draws a
// seat picker and a size-pack list, and neither has ever had a UI — both have
// been API-only since they shipped. Building them is not #293's job; the route
// and nav are plural so they land here later without a rename, and there are
// deliberately no "coming soon" placeholders standing in for them.
//
// Member-visible like Credits and Billing (an org owner inside a group they do
// not pay for should still see what the bill covers), with the purchase control
// itself payer-only. `lib/feature-copy.ts`'s 402 offer points customers here by
// name — "Settings → Add-ons" — so routes.addOns and that sentence move
// together.
import { requireBillingPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { BackLink } from "@/components/back-link";
import { getAddOnsTab } from "@/server/usecases/add-ons-tab";
import { preferredCurrency } from "@/lib/currency-server";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";
import { ExtraOrgsControl } from "@/components/extra-orgs-control";
import { Tip } from "@/components/ui/tip";

export default async function AddOnsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org, user, viaPayer } = await requireBillingPage(orgSlug, {
    tail: "/settings/add-ons",
  });
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");
  const currency = await preferredCurrency(org.id);
  const view = await getAddOnsTab(org.id, user.id, currency);

  // ONE capacity number on this page, and it is the one the customer bought
  // (`purchasedCapacity`). The resolver's admission cap is allowed to degrade
  // during dunning; a receipt is not. The degradation is said in words below
  // instead, so the page never shows two caps that disagree.
  const capSummary =
    view.orgCap === null
      ? t(dict, "addOns.cap.summaryUnlimited", { count: view.liveOrgCount })
      : t(dict, "addOns.cap.summary", { count: view.liveOrgCount, cap: view.orgCap });

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      {/* The org's own Settings index is member-gated, so a payer who is not a
          member of this club would only 404 on it (v17 gap #333). They arrived
          from the bill, not from the club, and have nothing to go back to
          here. */}
      {!viaPayer && (
        <BackLink
          href={routes.orgSettings(orgSlug)}
          label={t(dict, "action.settings")}
          emphasis="button"
        />
      )}
      <div className="mb-1 flex items-center gap-2">
        <h1 className="page-title">{t(dict, "settings.nav.addOns")}</h1>
        <Tip id="billing.addons.extra-org" small />
      </div>
      <p className="mb-6 text-sm text-slate-600">{t(dict, "addOns.intro")}</p>

      <p className="mb-4 text-sm font-medium text-slate-700">{capSummary}</p>

      {/* Never disables anything. A customer who can no longer afford a rider is
          here precisely to cancel it, and taking the control away would leave
          them paying for capacity they cannot use until they call support. */}
      {view.capReduced && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          {t(dict, "addOns.capReduced")}
        </p>
      )}

      {!view.addonAvailable || view.priceMinor === null ? (
        <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.communityNotice")}
        </p>
      ) : !view.hasLiveSubscription ? (
        <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.noLiveSubscription")}
        </p>
      ) : !view.isPayer ? (
        <p className="rounded-xl border border-purple-100 bg-purple-50/50 p-4 text-sm text-slate-600">
          {t(dict, "addOns.guestNotice")}
        </p>
      ) : (
        <ExtraOrgsControl
          initialCount={view.extraOrgCount}
          min={view.minExtraOrgs}
          max={view.maxExtraOrgs}
          priceMinor={view.priceMinor}
          currency={currency}
          dict={dict}
          locale={locale}
        />
      )}
    </main>
  );
}
