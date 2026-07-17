// Console shell for the /o/[orgSlug] tree (PROMPT-30): one Nav + breadcrumb
// bar for every page underneath — pages stop wiring their own chrome. Auth
// here allows scorers AND non-members through so fixture deep-links can reach
// requireFixturePage (design v2 §A2: an accepted official is usually NOT an
// org member); every non-fixture page re-checks membership and bounces them.
import { Nav } from "@/components/nav";
import { ActiveOrgSync } from "@/components/active-org-sync";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { notFound, permanentRedirect, redirect } from "next/navigation";
import { getCurrentUser, getActiveOrgId, getUserOrgs } from "@/lib/auth";
import { orgBySlug, breadcrumbNames } from "@/server/slug-resolve";
import { routes } from "@/lib/routes";
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
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const resolved = await orgBySlug(orgSlug);
  if (resolved && "renamedTo" in resolved) permanentRedirect(routes.orgHome(resolved.renamedTo));
  if (!resolved) notFound();

  const orgs = await getUserOrgs(user.id);
  const membership = orgs.find((o) => o.id === resolved.id);
  const locale = await resolveLocale();
  const ui = await getDictionary(locale, "ui");

  // Full console chrome only for members with an organiser role. Scorers (doc
  // 13 §3) AND non-members reaching a fixture deep-link (an accepted official —
  // design v2 §A2) get the stripped courtside shell: no org nav or breadcrumbs,
  // no active-org sync into an org they don't belong to. The child page does
  // the real gate — a non-member hitting anything but the fixture console 404s
  // there (every /o page runs its own requireOrgPage/…/requireFixturePage).
  const chromed = !!membership && membership.role !== "scorer";
  if (!chromed) {
    return (
      <DictProvider dict={ui} locale={locale}>
        {membership && <ActiveOrgSync orgId={resolved.id} stale={false} />}
        {children}
      </DictProvider>
    );
  }

  const [activeOrgId, names] = await Promise.all([
    getActiveOrgId(),
    breadcrumbNames(resolved.id),
  ]);
  return (
    <DictProvider dict={ui} locale={locale}>
      <Nav />
      <ActiveOrgSync orgId={resolved.id} stale={activeOrgId !== resolved.id} />
      <Breadcrumbs
        orgName={resolved.name}
        orgs={orgs.map((o) => ({ name: o.name, slug: o.slug }))}
        names={names}
      />
      {children}
    </DictProvider>
  );
}
