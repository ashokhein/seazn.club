export const dynamic = "force-dynamic";
// Org-less Connect path — forwards to the active org's Connect settings,
// carrying the Stripe Connect return params (?connect=return|refresh) so the
// onboarding round-trip reconciles on the org-scoped URL (billing's pattern).
import { redirect } from "next/navigation";
import { requirePageAuth } from "@/server/page-auth";
import { routes } from "@/lib/routes";

export default async function BareConnect({
  searchParams,
}: {
  searchParams: Promise<{ connect?: string }>;
}) {
  const [{ org }, sp] = await Promise.all([requirePageAuth(), searchParams]);
  const qs = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => v !== undefined) as [string, string][],
  ).toString();
  redirect(routes.connect(org.slug) + (qs ? `?${qs}` : ""));
}
