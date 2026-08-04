import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { MergePersons } from "@/server/api-v1/schemas";
import { mergePersons } from "@/server/usecases/person-merge";

type Ctx = { params: Promise<{ id: string }> };

/** Dedupe: absorb `duplicate_id` into this person (doc 08 §3, #404). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, MergePersons);
    const auth = await requireResourceAuth(req, "person", id, "write");
    // A merge is a human act and the ledger records who confirmed it, so a
    // principal with no user behind it cannot perform one. (#404 Task 7 turns
    // this into the full API-key ban plus an explicit confirmation field.)
    if (!auth.userId) {
      throw new HttpError(403, "a merge must be confirmed by a signed-in organiser", "MERGE_REQUIRES_USER");
    }
    return mergePersons(auth, id, body.duplicate_id, { confirmedBy: auth.userId });
  });
}
