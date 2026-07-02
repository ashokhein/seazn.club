export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { needsOnboarding } from "@/lib/activation";
import { listOrgSportPresets } from "@/lib/sport-presets";
import { getActiveOrgId } from "@/lib/auth";
import { Nav } from "@/components/nav";
import { OnboardingWizard } from "@/components/onboarding-wizard";

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const already = !(await needsOnboarding(user.id));
  if (already) redirect("/dashboard");

  const orgId = await getActiveOrgId();
  if (!orgId) redirect("/dashboard");

  const presets = await listOrgSportPresets(orgId);

  return (
    <>
      <Nav />
      <main className="mx-auto max-w-2xl px-4 py-12">
        <div className="mb-8 text-center">
          <div className="mb-3 text-5xl">🏆</div>
          <h1 className="text-3xl font-bold tracking-tight text-purple-900">
            Welcome to Seazn Club
          </h1>
          <p className="mt-2 text-slate-500">
            Pick the sport your club runs most — we'll pre-fill your first
            tournament so you can get started in seconds.
          </p>
        </div>
        <OnboardingWizard presets={presets} />
      </main>
    </>
  );
}
