export const dynamic = "force-dynamic";
// Legacy home — the console lives at /o/[orgSlug] now (PROMPT-30). Temporary
// redirect: the target depends on the viewer's active org.
import { redirect } from "next/navigation";
import { requirePageAuth } from "@/server/page-auth";
import { routes } from "@/lib/routes";

export default async function LegacyDashboard() {
  const { org } = await requirePageAuth();
  redirect(routes.orgHome(org.slug));
}
