import { v1 } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { listMerges } from "@/server/usecases/person-merge";

/**
 * The org's merge log (#404 Task 8b), newest first.
 *
 * A static segment under the same parent as `/persons/[id]`, like
 * `/persons/duplicates`: Next resolves the literal first, and `merges` is not a
 * uuid, so `GET /persons/{id}` cannot be shadowed either way. The API-key table
 * is not so lucky — `GET /persons/:id` matches this path, so the route is closed
 * to keys by an explicit `NEVER_KEY_ROUTES` entry rather than by absence.
 *
 * `limit` is clamped by the usecase (1…200); a junk value falls back to the
 * default rather than 400ing a read whose whole job is to be glanced at.
 */
export async function GET(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "read");
    const raw = Number(new URL(req.url).searchParams.get("limit"));
    return listMerges(auth, {
      limit: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined,
    });
  });
}
