// Slug hygiene for console URLs (PROMPT-30, v3/01 §2). Generated slugs never
// 409 — collisions suffix "-2", "-3", …; "new" is reserved because the static
// /c/new and /d/new routes win over the dynamic [slug] segments. Renames keep
// the old slug redirecting via slug_history (console /o/... and /shared).
import type postgres from "postgres";

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "untitled";
}

export const RESERVED_ENTITY_SLUGS: ReadonlySet<string> = new Set(["new"]);

/** First free slug: `base`, then `base-2`, `base-3`, … Reserved bases skip
 *  straight to `-2`. */
export async function uniqueSlug(
  base: string,
  taken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const start = RESERVED_ENTITY_SLUGS.has(base) ? 2 : 1;
  for (let n = start; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await taken(candidate))) return candidate;
  }
}

/** Rename bookkeeping. Latest rename wins when an old slug is recycled —
 *  live rows always beat history at resolve time. */
export async function recordSlugHistory(
  tx: postgres.Sql | postgres.TransactionSql,
  entityType: "org" | "competition" | "division",
  parentId: string | null,
  oldSlug: string,
  entityId: string,
): Promise<void> {
  await tx`
    insert into slug_history (entity_type, parent_id, old_slug, entity_id)
    values (${entityType}, ${parentId}, ${oldSlug}, ${entityId})
    on conflict (entity_type, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), old_slug)
    do update set entity_id = excluded.entity_id, created_at = now()`;
}
