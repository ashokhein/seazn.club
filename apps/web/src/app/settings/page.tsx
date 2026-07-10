export const dynamic = "force-dynamic";
// Legacy settings — org-scoped now (PROMPT-30). Keeps ?tab=.
import { redirect } from "next/navigation";
import { requirePageAuth } from "@/server/page-auth";
import { routes } from "@/lib/routes";

export default async function LegacySettings({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ org }, { tab }] = await Promise.all([requirePageAuth(), searchParams]);
  redirect(routes.orgSettings(org.slug, tab));
}
