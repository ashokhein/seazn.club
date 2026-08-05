import { ZodError } from "zod";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { ReverseMerge } from "@/server/api-v1/schemas";
import { reverseMerge } from "@/server/usecases/person-merge";

type Ctx = { params: Promise<{ id: string }> };

/** See the merge route: an unaffirmed undo is a refused action (422), not a
 *  malformed body (400). */
function confirmationOr422(err: unknown): never {
  if (err instanceof ZodError && err.issues.some((i) => i.path[0] === "confirmed")) {
    throw new HttpError(
      422,
      "a reversal must be explicitly confirmed by the organiser",
      "MERGE_NOT_CONFIRMED",
    );
  }
  throw err;
}

/**
 * Undo a merge (#404 §8). A `person_merges` id is not one of the resource
 * kinds `requireResourceAuth` can resolve an org from, and it needs no special
 * case: the caller is authenticated against their active org and RLS decides
 * whether the ledger row is theirs — a foreign merge id is a 404 from the
 * usecase, never an existence oracle.
 */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    // Authenticate BEFORE reading the body: an unauthenticated caller gets 401,
    // never a verdict on whether their payload was well formed.
    const auth = await requireAuth(req, "write");
    await parseBody(req, ReverseMerge).catch(confirmationOr422);
    if (!auth.userId) {
      throw new HttpError(
        403,
        "a reversal must be confirmed by a signed-in organiser",
        "MERGE_REQUIRES_USER",
      );
    }
    await reverseMerge(auth, id, { confirmedBy: auth.userId });
    return { reversed: true };
  });
}
