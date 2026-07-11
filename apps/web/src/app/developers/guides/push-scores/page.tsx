import type { Metadata } from "next";
import { CodeBlock, ScopeChip } from "@/components/dev-code-block";

export const metadata: Metadata = { title: "Push live scores from your scoreboard" };

export default function PushScoresGuide() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        Push live scores from your scoreboard
      </h1>
      <p className="mt-2 text-slate-600">
        Scoring is an append-only event ledger per fixture. Your integration
        appends events with a <ScopeChip scope="score" /> key; the platform
        folds them into live state, standings and dashboards.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">
        1 — Read the fixture state
      </h2>
      <CodeBlock>{`
curl https://seazn.club/api/v1/fixtures/$FIXTURE_ID/state \\
  -H "Authorization: Bearer sc_your_key"

# → { ok: true, data: { seq: 4, phase: "in_play", summary: {...} } }
`}</CodeBlock>
      <p className="mt-2 text-slate-600">
        <code className="font-mono text-sm">seq</code> is the ledger tip — every
        append must carry it as <code className="font-mono text-sm">expected_seq</code>.
        That is how two scorers can’t silently overwrite each other.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">2 — Append an event</h2>
      <CodeBlock>{`
curl -X POST https://seazn.club/api/v1/fixtures/$FIXTURE_ID/events \\
  -H "Authorization: Bearer sc_your_key" \\
  -H "Content-Type: application/json" \\
  -d '{ "expected_seq": 4,
        "type": "generic.result",
        "payload": { "p1Score": 21, "p2Score": 18 } }'
`}</CodeBlock>
      <p className="mt-2 text-slate-600">
        Event types are per sport (<code className="font-mono text-sm">generic.result</code>,{" "}
        <code className="font-mono text-sm">cricket.toss</code>, …) plus the core set
        (<code className="font-mono text-sm">core.start</code>,{" "}
        <code className="font-mono text-sm">core.void</code>,{" "}
        <code className="font-mono text-sm">core.finalize</code>). The reference
        documents the payload schema for each.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">
        3 — Recover from a 409
      </h2>
      <p className="mt-2 text-slate-600">
        Someone scored first. The 409 tells you the real tip — resync and retry:
      </p>
      <CodeBlock title="conflict loop (TypeScript)">{`
async function append(fixtureId: string, event: object, seq: number) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(
      \`https://seazn.club/api/v1/fixtures/\${fixtureId}/events\`,
      {
        method: "POST",
        headers: {
          Authorization: \`Bearer \${KEY}\`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...event, expected_seq: seq }),
      },
    );
    const body = await res.json();
    if (body.ok) return body.data;
    if (body.error.code === "SEQ_CONFLICT") {
      seq = body.error.current_seq; // resync and go again
      continue;
    }
    throw new Error(body.error.message);
  }
  throw new Error("gave up after 3 conflicts");
}
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">Good to know</h2>
      <ul className="mt-3 space-y-1.5 text-sm text-slate-600">
        <li>Scoring opens when the division starts — <code className="font-mono">POST /divisions/{"{id}"}/start</code> is also <ScopeChip scope="score" />.</li>
        <li>Finalizing locks the ledger and needs <ScopeChip scope="manage" /> — that stays a deliberate, human step.</li>
        <li>Stay under the per-key rate budget (<code className="font-mono">X-RateLimit-*</code>); batch reads with <code className="font-mono">GET /events?since_seq=</code> instead of polling state.</li>
        <li>For a one-day event without any integration, day-of device links do this same job from a phone browser.</li>
      </ul>
    </article>
  );
}
