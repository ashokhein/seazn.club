export const dynamic = "force-dynamic";
// Public register flow (doc 16 §1.1, PROMPT-20a item 3): division picker →
// eligibility-aware form (DOB + guardian consent for minors) → pay →
// confirmation. Uncached — remaining capacity is live.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { publicRegistrationInfo } from "@/server/usecases/registrations";
import { HttpError } from "@/lib/errors";
import { RegisterForm } from "@/components/public-site/register-form";

type Props = { params: Promise<{ orgSlug: string; competitionSlug: string }> };

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default async function RegisterPage({ params }: Props) {
  const { orgSlug, competitionSlug } = await params;
  let info;
  try {
    info = await publicRegistrationInfo(orgSlug, competitionSlug);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <p className="text-xs text-zinc-400">
        <Link href={`/${orgSlug}/${competitionSlug}`} className="hover:underline">
          {info.competition.name}
        </Link>{" "}
        / Register
      </p>
      <h1 className="mt-1 text-3xl font-bold tracking-tight">Register</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Pick a division, fill in your details — takes under a minute.
      </p>
      {info.divisions.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">
          Registration is not open for this competition.
        </p>
      ) : (
        <RegisterForm
          orgSlug={orgSlug}
          competitionSlug={competitionSlug}
          divisions={info.divisions}
        />
      )}
    </div>
  );
}
