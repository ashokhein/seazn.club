export const dynamic = "force-dynamic";
// Connect settings (spec 2026-07-12 §8; renamed from Payments 2026-07-18) —
// its own route like billing: Stripe Connect onboarding/status, the org's
// default payment method for new divisions, and the org-wide offline
// instructions. Returning from Stripe onboarding lands here (?connect=return)
// and the card re-reads live status.
import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary, t } from "@/lib/i18n";

export default async function ConnectSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrgPage(orgSlug, { tail: "/settings/connect" });
  const isOwner = org.role === "owner";
  const locale = await resolveLocale();
  const dict = await getDictionary(locale, "ui");

  const [row] = await sql<
    { payment_instructions: string | null; default_payment_method: "offline" | "stripe" }[]
  >`
    select payment_instructions, default_payment_method
    from organizations where id = ${org.id}`;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6">
        <Link
          href={routes.orgSettings(orgSlug)}
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          ← {t(dict, "action.settings")}
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">{t(dict, "payments.title")}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {t(dict, "payments.desc")}
        </p>
      </div>

      <section className="card p-6">
        <OrgPaymentInstructions
          orgId={org.id}
          initialValue={row?.payment_instructions ?? null}
          initialDefaultMethod={row?.default_payment_method ?? "offline"}
          isOwner={isOwner}
        />
      </section>

      <p className="mt-4 text-xs text-slate-400">
        {t(dict, "payments.planNote")}{" "}
        <Link href={routes.billing(orgSlug)} className="underline hover:text-slate-600">
          {t(dict, "payments.planBilling")}
        </Link>
        .
      </p>
    </main>
  );
}
