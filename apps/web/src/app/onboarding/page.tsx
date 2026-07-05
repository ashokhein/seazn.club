export const dynamic = "force-dynamic";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { needsOnboarding } from "@/lib/activation";
import { sql } from "@/lib/db";
import { Nav } from "@/components/nav";
import { OnboardingWizard } from "@/components/onboarding-wizard";

export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const already = !(await needsOnboarding(user.id));
  if (already) redirect("/dashboard");

  // Engine v2 sport catalog (seeded from the module registry by sync:sports).
  const sports = await sql<{ key: string; name: string }[]>`
    select key, name from sports order by name`;

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
            Create a competition, add a division for your sport, register
            entrants — and you&apos;re scoring within minutes.
          </p>
        </div>
        <OnboardingWizard sports={sports} />
      </main>
    </>
  );
}
