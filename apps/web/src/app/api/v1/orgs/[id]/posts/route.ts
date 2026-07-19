import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreatePost } from "@/server/api-v1/schemas";
import { toApiPost } from "@/server/api-v1/posts";
import { listPosts, createPost, type PostStatus } from "@/server/usecases/org-posts";

type Ctx = { params: Promise<{ id: string }> };

const STATUSES = new Set(["draft", "published", "archived"]);

/** Org news feed (console): all posts, optional ?status= filter. Free — manual
 *  posts are ungated on every plan (SPEC-2 PLG thesis). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    const raw = new URL(req.url).searchParams.get("status");
    const status = raw && STATUSES.has(raw) ? (raw as PostStatus) : undefined;
    return (await listPosts(auth, id, status)).map(toApiPost);
  });
}

/** Compose a post (starts as a draft; free on every plan). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const body = await parseBody(req, CreatePost);
    const auth = await requireOrgAuth(req, id, "write");
    return reply(
      201,
      toApiPost(
        await createPost(auth, id, {
          title: body.title,
          ...(body.body_md !== undefined ? { bodyMd: body.body_md } : {}),
          ...(body.kind !== undefined ? { kind: body.kind } : {}),
          ...(body.competition_id !== undefined ? { competitionId: body.competition_id } : {}),
          ...(body.division_id !== undefined ? { divisionId: body.division_id } : {}),
          ...(body.hero_image_path !== undefined ? { heroImagePath: body.hero_image_path } : {}),
        }),
      ),
    );
  });
}
