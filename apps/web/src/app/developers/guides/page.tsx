import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight } from "lucide-react";

export const metadata: Metadata = { title: "Guides" };

const GUIDES = [
  {
    slug: "auth-and-scopes",
    title: "Authentication & scopes",
    body: "Create a key, pick the right scope, pin it to one competition, handle 401/403/429.",
  },
  {
    slug: "read-standings",
    title: "Read standings into a sheet or site",
    body: "Pull live standings JSON with a read key — or with no key at all from a public dashboard.",
  },
  {
    slug: "push-scores",
    title: "Push live scores from your scoreboard",
    body: "The score-event ledger: expected_seq, optimistic concurrency, and recovering from a 409.",
  },
] as const;

export default function GuidesPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Guides</h1>
      <p className="mt-2 text-slate-600">
        The two integration jobs we see most, plus the auth model they both need.
      </p>
      <ul className="mt-8 space-y-4">
        {GUIDES.map((g) => (
          <li key={g.slug}>
            <Link
              href={`/developers/guides/${g.slug}`}
              className="group block rounded-2xl border border-slate-200 p-5 transition hover:-translate-y-0.5 hover:border-purple-300 hover:shadow-md"
            >
              <h2 className="flex items-center gap-1.5 font-semibold text-slate-900">
                {g.title}
                <ArrowRight
                  className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-purple-500"
                  strokeWidth={2}
                />
              </h2>
              <p className="mt-1 text-sm text-slate-600">{g.body}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
