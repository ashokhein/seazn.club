// Regression: the org-posts v1 API must speak snake_case like the rest of
// the surface (auto_posts on Division, org_id on Competition, module_version
// on Fixture). The live smoke gate caught a camelCase drift in OrgPost
// (orgId/bodyMd/autoSource/...) — scripts/smoke.ts's newsSuite asserts
// `auto_source` and found nothing. This locks the wire contract.
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { OrgPost } from "../schemas";
import { toApiPost } from "../posts";
import type { OrgPost as UsecasePost } from "@/server/usecases/org-posts";

const sample: UsecasePost = {
  id: randomUUID(),
  orgId: randomUUID(),
  competitionId: null,
  divisionId: null,
  kind: "result",
  status: "draft",
  slug: "match-day-report",
  title: "Match Day Report",
  bodyMd: "**Riverside** win 3-1.",
  heroImagePath: null,
  autoSource: { trigger: "fixture_decided", fixture_id: randomUUID(), stale: false },
  publishedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe("OrgPost API response is snake_case (house convention)", () => {
  it("toApiPost() maps the camelCase usecase shape onto the snake wire schema", () => {
    const wire = toApiPost(sample);
    expect(wire).toMatchObject({
      id: sample.id,
      org_id: sample.orgId,
      competition_id: sample.competitionId,
      division_id: sample.divisionId,
      body_md: sample.bodyMd,
      hero_image_path: sample.heroImagePath,
      auto_source: sample.autoSource,
      published_at: sample.publishedAt,
      created_at: sample.createdAt,
      updated_at: sample.updatedAt,
    });
    expect(OrgPost.safeParse(wire).success).toBe(true);
  });

  it("rejects the old camelCase payload — auto_source/body_md/org_id are required snake keys", () => {
    const camel = {
      id: sample.id,
      orgId: sample.orgId,
      competitionId: sample.competitionId,
      divisionId: sample.divisionId,
      kind: sample.kind,
      status: sample.status,
      slug: sample.slug,
      title: sample.title,
      bodyMd: sample.bodyMd,
      heroImagePath: sample.heroImagePath,
      autoSource: sample.autoSource,
      publishedAt: sample.publishedAt,
      createdAt: sample.createdAt,
      updatedAt: sample.updatedAt,
    };
    expect(OrgPost.safeParse(camel).success).toBe(false);
  });
});
