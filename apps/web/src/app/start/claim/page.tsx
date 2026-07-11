import { MarketingNav } from "@/components/marketing-nav";
import { FunnelClaim } from "@/components/funnel-claim";

/** Landing for the emailed funnel link (v3/07 §6) — the token signs the
 *  visitor in AND creates the drafted competition. */
export default async function FunnelClaimPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  return (
    <>
      <MarketingNav />
      <main className="mx-auto max-w-md px-4 py-12">
        <FunnelClaim token={token ?? null} />
      </main>
    </>
  );
}
