export const dynamic = "force-dynamic";
// Competition shell (v3/07 §3): resolves the Event Pass for THIS competition
// once per request and provides it to every client island underneath, so gates
// stop being unable to ask. Every page below already declares force-dynamic;
// this repeats it because the layout itself does an uncached DB read.
//
// Deliberately NOT auth-gated. `requireCompetitionPage` 404s scorers and
// non-members, but the /o layout lets both through on purpose so an accepted
// official's fixture deep-link (design v2 §A2) can reach `requireFixturePage`
// further down. A layout that gated here would break that link before the page
// that owns the decision ever ran. Every child page still runs its own gate, so
// this adds no surface — only a boolean about a competition already in the URL.
//
// Anything unresolvable (missing org, missing competition, or a slug that only
// exists in slug_history) yields `false` and renders children untouched: the
// child page owns the 404 / permanent-redirect, and a pass state is never worth
// pre-empting it.
import { sql } from "@/lib/db";
import { orgBySlug, compBySlug } from "@/server/slug-resolve";
import { CompetitionPassProvider } from "@/components/competition-pass-provider";

/**
 * `params` is a PROMISE in this version of Next and must be awaited —
 * confirmed in `node_modules/next/dist/docs/01-app/03-api-reference/
 * 03-file-conventions/layout.md` ("Props → params (optional): A promise that
 * resolves to an object containing the dynamic route parameters … You must use
 * async/await or React's `use` function"). The docs also offer a generated
 * `LayoutProps<'/o/[orgSlug]/c/[compSlug]'>` helper, but it only exists after
 * `next dev` / `next build` / `next typegen` has run, so `npx tsc --noEmit` on
 * a clean checkout would not see it. The explicit Promise type is what the rest
 * of this tree uses (see the sibling `/o/[orgSlug]/layout.tsx`).
 */
export default async function CompetitionLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string; compSlug: string }>;
}) {
  const { orgSlug, compSlug } = await params;
  return (
    <CompetitionPassProvider active={await passActive(orgSlug, compSlug)}>
      {children}
    </CompetitionPassProvider>
  );
}

/**
 * Is there a `competition_passes` row for this competition?
 *
 * The slug lookups go through the React-`cache()`d resolvers, which the org
 * layout and the child page already call with the same arguments — so in the
 * common request this costs exactly one extra query, the pass probe itself.
 *
 * `stripe_payment_intent` is NOT consulted: it is nullable by design (V271),
 * and a staff-granted pass with a null intent is fully active.
 */
async function passActive(orgSlug: string, compSlug: string): Promise<boolean> {
  const org = await orgBySlug(orgSlug);
  if (!org || "renamedTo" in org) return false;
  const comp = await compBySlug(org.id, compSlug);
  if (!comp || "renamedTo" in comp) return false;
  const [pass] = await sql<{ one: number }[]>`
    select 1 as one from competition_passes where competition_id = ${comp.id} limit 1`;
  return !!pass;
}
