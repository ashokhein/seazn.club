export const dynamic = "force-dynamic";
// Legacy create route — org-scoped now (PROMPT-30).
import { redirect } from "next/navigation";
import { requirePageAuth } from "@/server/page-auth";
import { routes } from "@/lib/routes";

export default async function LegacyNewCompetition() {
  const { org } = await requirePageAuth();
  redirect(routes.competitionNew(org.slug));
}
