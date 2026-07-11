import Link from "next/link";
import { ArrowRight, BookOpen, KeyRound, ScrollText } from "lucide-react";
import { CodeBlock, ScopeChip } from "@/components/dev-code-block";

export default function DevelopersPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      {/* Hero */}
      <div className="max-w-2xl">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-purple-600">
          Platform API
        </p>
        <h1 className="mt-2 text-4xl font-bold tracking-tight text-slate-900">
          Your tournament data, one Bearer token away
        </h1>
        <p className="mt-4 text-lg text-slate-600">
          Read standings into your club site, push live scores from your own
          scoreboard, automate entries. REST, OpenAPI&nbsp;3.1, an envelope
          that never surprises you.
        </p>
      </div>

      <CodeBlock title="60-second start">{`
# 1. Create a key in Org settings → Platform API (Pro)
# 2. Read your competitions
curl https://seazn.club/api/v1/competitions \\
  -H "Authorization: Bearer sc_your_key"

# → { "ok": true, "data": { "items": [...] }, "requestId": "…" }
`}</CodeBlock>

      {/* Scope ladder — the one thing to understand before anything else */}
      <section className="mt-10">
        <h2 className="text-xl font-semibold text-slate-900">
          Three scopes, one ladder
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Every key carries a scope; every endpoint declares the scope it
          needs (<code className="font-mono text-xs">x-required-scope</code>{" "}
          in the spec). Higher rungs include the lower ones.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {(
            [
              ["read", "Fetch everything your org can see — competitions, fixtures, standings, registrations."],
              ["score", "Push score events and start divisions. Built for scoreboard integrations."],
              ["manage", "The full surface: create, generate, schedule, moderate. Treat it like a password."],
            ] as const
          ).map(([scope, line]) => (
            <div
              key={scope}
              className="rounded-2xl border border-slate-200 p-4 transition hover:border-purple-200 hover:shadow-sm"
            >
              <ScopeChip scope={scope} />
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{line}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-sm text-slate-500">
          Public dashboards need no key at all — the{" "}
          <ScopeChip scope="public" /> tag is open, cacheable JSON.
        </p>
      </section>

      {/* Cards */}
      <section className="mt-10 grid gap-4 sm:grid-cols-3">
        {[
          {
            href: "/developers/reference",
            icon: ScrollText,
            title: "API reference",
            body: "Every operation with schemas, examples and a try-it console.",
          },
          {
            href: "/developers/guides",
            icon: BookOpen,
            title: "Guides",
            body: "Auth & scopes, reading standings, pushing live scores.",
          },
          {
            href: "/developers/changelog",
            icon: KeyRound,
            title: "Changelog & versioning",
            body: "Additive changes announced here; breaking changes get a new version path.",
          },
        ].map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-2xl border border-slate-200 p-5 transition hover:-translate-y-0.5 hover:border-purple-300 hover:shadow-md"
          >
            <c.icon className="h-5 w-5 text-purple-500" strokeWidth={1.75} />
            <h3 className="mt-3 flex items-center gap-1 font-semibold text-slate-900">
              {c.title}
              <ArrowRight
                className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-purple-500"
                strokeWidth={2}
              />
            </h3>
            <p className="mt-1 text-sm text-slate-600">{c.body}</p>
          </Link>
        ))}
      </section>

      <section className="mt-10 rounded-2xl bg-purple-50/60 p-5 text-sm text-slate-600">
        <p>
          <span className="font-semibold text-slate-800">Rate limits:</span>{" "}
          60 requests/minute per key (300 on Pro). Every response carries{" "}
          <code className="font-mono text-xs">X-RateLimit-Limit / -Remaining / -Reset</code>;
          a 429 uses the standard error envelope.
        </p>
        <p className="mt-2">
          <span className="font-semibold text-slate-800">Pin a key:</span>{" "}
          limit it to one competition when handing it to a vendor — it can’t
          touch anything else.
        </p>
      </section>
    </div>
  );
}
