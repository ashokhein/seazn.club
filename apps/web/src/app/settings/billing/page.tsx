export const dynamic = "force-dynamic";
// Legacy billing — org-scoped now (PROMPT-30). Forwards Stripe checkout
// return params so in-flight sessions reconcile on the new URL.
import { redirect } from "next/navigation";
import { requirePageAuth } from "@/server/page-auth";
import { routes } from "@/lib/routes";

export default async function LegacyBilling({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; session_id?: string }>;
}) {
  const [{ org }, sp] = await Promise.all([requirePageAuth(), searchParams]);
  const qs = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => v !== undefined) as [string, string][],
  ).toString();
  redirect(routes.billing(org.slug) + (qs ? `?${qs}` : ""));
}
