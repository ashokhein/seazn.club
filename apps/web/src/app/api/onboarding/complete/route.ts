import { NextResponse } from "next/server";
import { getActiveOrgId, getCurrentUser, getUserOrgs } from "@/lib/auth";
import { markOnboardingDone } from "@/lib/activation";
import { ONBOARDING_EARN, tryEarnGrant } from "@/lib/credits";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await markOnboardingDone(user.id);

  // Growth loop (SPEC-5 §2 B): completing onboarding earns the org free AI
  // credits. Best-effort and idempotent per org (tryEarnGrant never throws) — a
  // grant failure must not fail onboarding, and re-completing never double-grants.
  // Grant to the user's active org (a user reaching "onboarding complete" has an
  // org); no side-effecting ensureActiveOrg here — read-only resolution, skip if
  // none.
  const orgs = await getUserOrgs(user.id);
  if (orgs.length > 0) {
    const activeId = await getActiveOrgId();
    const orgId = orgs.find((o) => o.id === activeId)?.id ?? orgs[0].id;
    await tryEarnGrant(orgId, "onboarding", ONBOARDING_EARN);
  }

  return NextResponse.json({ ok: true });
}
