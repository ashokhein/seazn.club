import { v1 } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { listAssignedFixtures } from "@/server/usecases/scorers";

/** The scorer console read (doc 13 §6): fixtures covered by the caller's
 *  assignments across all their orgs. Session-only — assignments are personal;
 *  ?date=YYYY-MM-DD narrows to one day. */
export async function GET(req: Request) {
  return v1(async () => {
    const user = await requireUser();
    const raw = new URL(req.url).searchParams.get("date");
    if (raw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      throw new HttpError(400, "Invalid date — expected YYYY-MM-DD");
    }
    return listAssignedFixtures(user.id, raw ?? undefined);
  });
}
