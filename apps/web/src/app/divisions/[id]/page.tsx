export const dynamic = "force-dynamic";
// Legacy id route — 301s to the slug chain, keeping ?tab= (PROMPT-30).
import { permanentRedirect } from "next/navigation";
import { legacyPath } from "@/server/legacy-routes";

export default async function Legacy({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const path = await legacyPath("division", id);
  permanentRedirect(tab ? `${path}?tab=${tab}` : path);
}
