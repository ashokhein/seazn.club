import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { MergePersons } from "@/server/api-v1/schemas";
import { mergePersons } from "@/server/usecases/persons";

type Ctx = { params: Promise<{ id: string }> };

/** Dedupe: absorb `duplicate_id` into this person (doc 08 §3). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, MergePersons);
    const auth = await requireResourceAuth(req, "person", id, "write");
    return mergePersons(auth, id, body.duplicate_id);
  });
}
