export const dynamic = "force-dynamic";
// Payments settings (spec 2026-07-12 §8) — its own route like billing:
// Stripe Connect onboarding/status, the org's default payment method for new
// divisions, and the org-wide offline instructions. Returning from Stripe
// onboarding lands here (?connect=return) and the card re-reads live status.
import Link from "@/components/ui/console-link";
import { sql } from "@/lib/db";
import { requireOrgPage } from "@/server/page-auth";
import { routes } from "@/lib/routes";
import { OrgPaymentInstructions } from "@/components/org-payment-instructions";

export default async function PaymentsSettingsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { org } = await requireOrgPage(orgSlug, { tail: "/settings/payments" });
  const isOwner = org.role === "owner";

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
          ← Settings
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Payments</h1>
        <p className="mt-1 text-sm text-slate-500">
          How your entry fees are collected — card payments via Stripe, or your own
          cash / bank-transfer instructions. Each division picks its method in its
          registration settings.
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
        Plan and subscription live under{" "}
        <Link href={routes.billing(orgSlug)} className="underline hover:text-slate-600">
          Plan &amp; billing
        </Link>
        .
      </p>
    </main>
  );
}
