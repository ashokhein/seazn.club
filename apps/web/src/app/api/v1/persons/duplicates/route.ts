import { v1 } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { listDuplicateCandidates } from "@/server/usecases/person-duplicates";

/**
 * The ranked duplicate queue for the caller's org (#404 §8).
 *
 * A static segment under the same parent as `/persons/[id]`, so it must never
 * be a valid person id — Next resolves the literal first, and `duplicates` is
 * not a uuid, so `GET /persons/{id}` cannot be shadowed either way.
 *
 * `limit` is clamped by the usecase (1…200); a junk value falls back to the
 * default rather than 400ing a read whose whole job is to be glanced at.
 */
export async function GET(req: Request) {
  return v1(async () => {
    const auth = await requireAuth(req, "read");
    const raw = Number(new URL(req.url).searchParams.get("limit"));
    return listDuplicateCandidates(auth, {
      limit: Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined,
    });
  });
}
