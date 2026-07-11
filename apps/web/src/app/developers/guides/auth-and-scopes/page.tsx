import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock, ScopeChip } from "@/components/dev-code-block";

export const metadata: Metadata = { title: "Authentication & scopes" };

export default function AuthGuide() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        Authentication &amp; scopes
      </h1>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">Get a key</h2>
      <p className="mt-2 text-slate-600">
        In your organisation: <strong>Settings → Platform API → Create key</strong>{" "}
        (Pro plan). The <code className="font-mono text-sm">sc_…</code> secret is
        shown exactly once — store it like a password. Send it on every request:
      </p>
      <CodeBlock>{`
Authorization: Bearer sc_your_key
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">Pick a scope</h2>
      <p className="mt-2 text-slate-600">
        Scopes are ranked — each includes everything below it. Start with{" "}
        <ScopeChip scope="read" /> and only step up when an endpoint tells you to.
      </p>
      <ul className="mt-3 space-y-2 text-slate-600">
        <li>
          <ScopeChip scope="read" /> — GET anything your org can see.
        </li>
        <li>
          <ScopeChip scope="score" /> — also POST score events and start divisions.
        </li>
        <li>
          <ScopeChip scope="manage" /> — the full surface: create, generate, moderate.
        </li>
      </ul>
      <p className="mt-3 text-slate-600">
        Each operation in the{" "}
        <Link href="/developers/reference" className="text-purple-700 underline">
          reference
        </Link>{" "}
        declares its requirement as{" "}
        <code className="font-mono text-sm">x-required-scope</code>. Billing, org
        membership and key management are never reachable with a key, whatever the
        scope.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">
        Pin a key to one competition
      </h2>
      <p className="mt-2 text-slate-600">
        When a scoreboard vendor only needs one event, create the key with a
        competition pin. It authenticates normally but 403s anywhere outside that
        competition — including org-wide collection endpoints.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">Errors you will meet</h2>
      <CodeBlock title="the error envelope">{`
{ "ok": false,
  "error": { "code": "FORBIDDEN", "message": "This key is limited to 'read' — this endpoint needs the 'manage' scope. Create a key with the right scope in org settings." },
  "requestId": "…" }
`}</CodeBlock>
      <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
        <li><code className="font-mono">401 UNAUTHENTICATED</code> — bad or revoked key.</li>
        <li><code className="font-mono">403 FORBIDDEN</code> — scope too low, pinned elsewhere, or a key can’t use that endpoint at all.</li>
        <li><code className="font-mono">402 PAYMENT_REQUIRED</code> — the org’s plan doesn’t include the feature; <code className="font-mono">error.feature_key</code> says which.</li>
        <li><code className="font-mono">429 RATE_LIMITED</code> — over the per-key budget; check <code className="font-mono">X-RateLimit-Reset</code> and retry after it.</li>
      </ul>
    </article>
  );
}
