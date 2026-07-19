import "server-only";
import type { z } from "zod";
import type { OrgPost as UsecasePost } from "@/server/usecases/org-posts";
import { OrgPost as ApiPostSchema } from "@/server/api-v1/schemas";

/** camelCase usecase shape → snake_case /api/v1 wire shape (S.OrgPost). The
 *  usecase layer stays camelCase for server components; every route that
 *  returns a post must serialize through here so the API matches the rest of
 *  the house convention (auto_posts, org_id, module_version, ...). */
export function toApiPost(p: UsecasePost): z.infer<typeof ApiPostSchema> {
  return {
    id: p.id,
    org_id: p.orgId,
    competition_id: p.competitionId,
    division_id: p.divisionId,
    kind: p.kind,
    status: p.status,
    slug: p.slug,
    title: p.title,
    body_md: p.bodyMd,
    hero_image_path: p.heroImagePath,
    auto_source: p.autoSource,
    published_at: p.publishedAt,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}
