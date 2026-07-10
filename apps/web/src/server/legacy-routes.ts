import "server-only";
// Legacy id-route resolution (PROMPT-30, v3/01 §2): /competitions/[id],
// /divisions/[id] and /fixtures/[id] 301 to the slug chain. Auth-first —
// the old routes 404'd for non-members, so the redirects must too
// (existence never leaks through a Location header). Keep ≥2 releases;
// grep logs for [legacy-route] to know when they're dead.
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, getUserOrgs } from "@/lib/auth";
import { resourceOrg } from "@/server/api-v1/auth";
import { sql } from "@/lib/db";
import { routes } from "@/lib/routes";
import { HttpError } from "@/lib/errors";

export type LegacyKind = "competition" | "division" | "fixture";

export async function legacyPath(kind: LegacyKind, id: string, tail = ""): Promise<string> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  let orgId: string;
  try {
    orgId = await resourceOrg(kind, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const orgs = await getUserOrgs(user.id);
  const org = orgs.find((o) => o.id === orgId);
  if (!org) notFound();

  let path: string;
  if (kind === "competition") {
    const [row] = await sql<{ slug: string }[]>`
      select slug from competitions where id = ${id}`;
    if (!row) notFound();
    path = routes.competition(org.slug, row.slug) + tail;
  } else if (kind === "division") {
    const [row] = await sql<{ slug: string; comp_slug: string }[]>`
      select d.slug, c.slug as comp_slug
      from divisions d join competitions c on c.id = d.competition_id
      where d.id = ${id}`;
    if (!row) notFound();
    path = routes.division(org.slug, row.comp_slug, row.slug) + tail;
  } else {
    const [row] = await sql<{ fixture_no: number; slug: string; comp_slug: string }[]>`
      select f.fixture_no, d.slug, c.slug as comp_slug
      from fixtures f
      join divisions d on d.id = f.division_id
      join competitions c on c.id = d.competition_id
      where f.id = ${id}`;
    if (!row) notFound();
    path = routes.fixture(org.slug, row.comp_slug, row.slug, row.fixture_no);
  }
  console.log(`[legacy-route] kind=${kind} id=${id} -> ${path}`);
  return path;
}
