// Console shell for the /o/[orgSlug] tree (PROMPT-30): one Nav + breadcrumb
// bar for every page underneath — pages stop wiring their own chrome. Auth
// here allows scorers through so fixture deep-links can reach
// requireFixturePage; every non-fixture page re-checks and bounces them.
import { Nav } from "@/components/nav";
import { ActiveOrgSync } from "@/components/active-org-sync";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { getActiveOrgId, getUserOrgs } from "@/lib/auth";
import { requireOrgPage } from "@/server/page-auth";
import { breadcrumbNames } from "@/server/slug-resolve";
import { resolveLocale } from "@/lib/resolve-locale";
import { getDictionary } from "@/lib/i18n";
import { DictProvider } from "@/components/i18n/dict-provider";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const { user, org } = await requireOrgPage(orgSlug, { allowScorer: true });
  const [activeOrgId, orgs, names, locale] = await Promise.all([
    getActiveOrgId(),
    getUserOrgs(user.id),
    breadcrumbNames(org.id),
    resolveLocale(),
  ]);
  // The `ui` copy catalog for the whole console subtree — client islands read it
  // via useMsg(); only the active locale crosses the boundary (v5 i18n cycle 47).
  const ui = await getDictionary(locale, "ui");
  // Scorers keep the stripped courtside view (doc 13 §3): no org nav or
  // breadcrumbs — their only /o surface is the fixture console.
  const scorer = org.role === "scorer";
  return (
    <DictProvider dict={ui} locale={locale}>
      {!scorer && <Nav />}
      <ActiveOrgSync orgId={org.id} stale={activeOrgId !== org.id} />
      {!scorer && (
        <Breadcrumbs
          orgName={org.name}
          orgs={orgs.map((o) => ({ name: o.name, slug: o.slug }))}
          names={names}
        />
      )}
      {children}
    </DictProvider>
  );
}
