import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PatchPost } from "@/server/api-v1/schemas";
import { toApiPost } from "@/server/api-v1/posts";
import { getPost, updatePost, deletePost } from "@/server/usecases/org-posts";

type Ctx = { params: Promise<{ id: string }> };

/** One post (console). Free — manual news is ungated (SPEC-2). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "org_post", id, "read");
    return toApiPost(await getPost(auth, id));
  });
}

/** Edit + lifecycle: PATCH body carries field edits and/or `action` (publish
 *  stamps published_at + freezes the slug; archive hides). */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "org_post", id, "write");
    const body = await parseBody(req, PatchPost);
    return toApiPost(
      await updatePost(auth, id, {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.body_md !== undefined ? { bodyMd: body.body_md } : {}),
        ...(body.hero_image_path !== undefined ? { heroImagePath: body.hero_image_path } : {}),
        ...(body.competition_id !== undefined ? { competitionId: body.competition_id } : {}),
        ...(body.division_id !== undefined ? { divisionId: body.division_id } : {}),
        ...(body.action !== undefined ? { action: body.action } : {}),
      }),
    );
  });
}

/** Delete a post (drafts + published). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "org_post", id, "write");
    await deletePost(auth, id);
    return reply(204, null);
  });
}
