// Org landing (doc 09 §1): the org's `public` competitions. Unlisted ones are
// reachable by direct link only — never listed here.
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getPublicOrg } from "@/server/public-site/data";

export const revalidate = 30;

type Props = { params: Promise<{ orgSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { orgSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) return {};
  return {
    title: data.org.name,
    description: `Competitions run by ${data.org.name}`,
  };
}

export default async function OrgLandingPage({ params }: Props) {
  const { orgSlug } = await params;
  const data = await getPublicOrg(orgSlug);
  if (!data) notFound();
  const { org, competitions } = data;

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">{org.name}</h1>
      {competitions.length === 0 ? (
        <p className="text-sm text-zinc-500">No public competitions right now.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {competitions.map((c) => (
            <li key={c.id}>
              <Link
                href={`/${org.slug}/${c.slug}`}
                className="block rounded-lg border border-zinc-200 bg-white p-4 shadow-sm hover:border-zinc-400"
              >
                <p className="font-medium">{c.name}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {c.starts_on
                    ? new Date(c.starts_on).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })
                    : null}
                  {c.ends_on
                    ? ` – ${new Date(c.ends_on).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}`
                    : null}
                  {!c.starts_on && !c.ends_on ? c.status : null}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
