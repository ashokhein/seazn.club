export const dynamic = "force-dynamic";
// Legacy home — the console lives at /o/[orgSlug] now (PROMPT-30). Temporary
// redirect: the target depends on the viewer's active org.
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isPlayerOnly } from "@/server/usecases/me";
import { requirePageAuth } from "@/server/page-auth";
import { routes } from "@/lib/routes";

export default async function LegacyDashboard() {
  // Claimed players without an org go home to /me (PROMPT-53) — BEFORE
  // requirePageAuth, which would auto-provision them a "My organization".
  const user = await getCurrentUser();
  if (user && (await isPlayerOnly(user.id))) redirect(routes.me());

  const { org } = await requirePageAuth();
  redirect(routes.orgHome(org.slug));
}
