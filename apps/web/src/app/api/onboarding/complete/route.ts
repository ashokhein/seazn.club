import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { markOnboardingDone } from "@/lib/activation";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await markOnboardingDone(user.id);
  // The onboarding-completion earn credit (SPEC-5 §2) used to fire HERE —
  // moved by v17 gap #296 to only pay out once the org publishes a
  // competition with a division (server/usecases/competitions.ts's
  // patchCompetition, shouldFireGrowthEarnGrants). Completing onboarding is
  // no longer itself a credit-earning event.
  return NextResponse.json({ ok: true });
}
