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
  // Best-effort covers the ORG RESOLUTION too, not just the grant: getUserOrgs /
  // getActiveOrgId throwing must not 500 onboarding after markOnboardingDone has
  // committed (tryEarnGrant alone swallows only its own errors).
  try {
    const orgs = await getUserOrgs(user.id);
    if (orgs.length > 0) {
      const activeId = await getActiveOrgId();
      const orgId = orgs.find((o) => o.id === activeId)?.id ?? orgs[0].id;
      await tryEarnGrant(orgId, "onboarding", ONBOARDING_EARN);
    }
  } catch {
    // earn is a growth-loop nicety; never let it fail onboarding completion.
  }

  return NextResponse.json({ ok: true });
}
