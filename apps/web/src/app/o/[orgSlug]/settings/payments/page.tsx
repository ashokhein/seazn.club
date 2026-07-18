// The Payments settings page is now Connect (renamed 2026-07-18). Old links —
// bookmarks and Stripe onboarding return/refresh URLs minted before the
// rename — land here and forward with their query intact.
import { redirect } from "next/navigation";
import { routes } from "@/lib/routes";

export default async function LegacyOrgPayments({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ orgSlug }, sp] = await Promise.all([params, searchParams]);
  const qs = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => v !== undefined) as [string, string][],
  ).toString();
  redirect(routes.connect(orgSlug) + (qs ? `?${qs}` : ""));
}
