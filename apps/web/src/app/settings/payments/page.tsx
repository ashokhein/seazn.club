// Renamed to /settings/connect (2026-07-18); old org-less links forward with
// their query intact (Stripe return params included).
import { redirect } from "next/navigation";

export default async function LegacyBarePayments({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams(
    Object.entries(sp).filter(([, v]) => v !== undefined) as [string, string][],
  ).toString();
  redirect(`/settings/connect${qs ? `?${qs}` : ""}`);
}
