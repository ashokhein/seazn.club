import { ZodError } from "zod";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HttpError } from "@/lib/errors";
import { MergePersons } from "@/server/api-v1/schemas";
import { mergePersons } from "@/server/usecases/person-merge";

type Ctx = { params: Promise<{ id: string }> };

/**
 * A body without `confirmed: true` is a refused ACTION, not a malformed
 * request — the organiser has simply not said yes yet. `v1()` maps every
 * ZodError to 400 VALIDATION, which is the wrong story for the one field the
 * panel must key on, so that single issue is rethrown as 422 with a stable
 * code. (Duplicated verbatim in the reverse route: the shared home would be
 * api-v1/schemas.ts, which is deliberately pure Zod so the OpenAPI generator
 * can run it outside the `@/` alias.)
 */
function confirmationOr422(err: unknown): never {
  if (err instanceof ZodError && err.issues.some((i) => i.path[0] === "confirmed")) {
    throw new HttpError(
      422,
      "a merge must be explicitly confirmed by the organiser",
      "MERGE_NOT_CONFIRMED",
    );
  }
  throw err;
}

/** Dedupe: absorb `duplicate_id` into this person (doc 08 §3, #404). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, MergePersons).catch(confirmationOr422);
    const auth = await requireResourceAuth(req, "person", id, "write");
    // API keys are barred at the auth door (NEVER_KEY_ROUTES), so a principal
    // with no user behind it should be unreachable here. It stays a 403 all
    // the same: `confirmedBy` is the ledger's record of WHO said yes, and a
    // merge carrying nobody's name is the un-auditable act #404 exists to end.
    if (!auth.userId) {
      throw new HttpError(
        403,
        "a merge must be confirmed by a signed-in organiser",
        "MERGE_REQUIRES_USER",
      );
    }
    return mergePersons(auth, id, body.duplicate_id, {
      confirmedBy: auth.userId,
      allowDobMismatch: body.allow_dob_mismatch,
    });
  });
}
