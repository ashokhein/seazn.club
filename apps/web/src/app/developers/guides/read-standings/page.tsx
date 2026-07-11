import type { Metadata } from "next";
import { CodeBlock, ScopeChip } from "@/components/dev-code-block";

export const metadata: Metadata = { title: "Read standings into a sheet or site" };

export default function ReadStandingsGuide() {
  return (
    <article className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">
        Read standings into a sheet or site
      </h1>
      <p className="mt-2 text-slate-600">
        Two doors. If the division is on a public dashboard, you don’t need a key
        at all. For private data, a <ScopeChip scope="read" /> key does it.
      </p>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">
        No key: the public read API
      </h2>
      <p className="mt-2 text-slate-600">
        Everything a public dashboard shows is also JSON — slugs are in the
        dashboard URL (<code className="font-mono text-sm">/shared/&lt;org&gt;/&lt;competition&gt;/&lt;division&gt;</code>):
      </p>
      <CodeBlock title="public standings">{`
curl https://seazn.club/api/v1/public/orgs/riverside/competitions/summer-league/divisions/mens-a/standings
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">
        With a read key: any division
      </h2>
      <CodeBlock title="private standings">{`
# stages of a division
curl https://seazn.club/api/v1/divisions/$DIVISION_ID/stages \\
  -H "Authorization: Bearer sc_your_key"

# standings snapshot of a stage
curl https://seazn.club/api/v1/stages/$STAGE_ID/standings \\
  -H "Authorization: Bearer sc_your_key"
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">Google Sheets</h2>
      <p className="mt-2 text-slate-600">
        Apps Script’s <code className="font-mono text-sm">UrlFetchApp</code> +
        a time-driven trigger keeps a sheet current:
      </p>
      <CodeBlock title="Code.gs">{`
function pullStandings() {
  const res = UrlFetchApp.fetch(
    "https://seazn.club/api/v1/stages/" + STAGE_ID + "/standings",
    { headers: { Authorization: "Bearer " + KEY } });
  const rows = JSON.parse(res.getContentText()).data.rows;
  const sheet = SpreadsheetApp.getActiveSheet();
  sheet.clearContents();
  sheet.appendRow(["Rank", "Entrant", "P", "Pts"]);
  rows.forEach(r => sheet.appendRow([r.rank, r.entrant_name, r.played, r.points]));
}
`}</CodeBlock>

      <h2 className="mt-8 text-xl font-semibold text-slate-900">TypeScript</h2>
      <CodeBlock title="standings.ts">{`
const res = await fetch(
  \`https://seazn.club/api/v1/stages/\${stageId}/standings\`,
  { headers: { Authorization: \`Bearer \${process.env.SEAZN_KEY}\` } },
);
const body = await res.json();
if (!body.ok) throw new Error(body.error.message);
console.table(body.data.rows);
`}</CodeBlock>

      <p className="mt-6 rounded-xl bg-purple-50/60 p-4 text-sm text-slate-600">
        Prefer an iframe? Pro orgs can embed live standings directly — see the
        sharing panel on any division, no code beyond a copy-paste snippet.
      </p>
    </article>
  );
}
