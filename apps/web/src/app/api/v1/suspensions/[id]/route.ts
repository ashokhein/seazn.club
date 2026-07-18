import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { DecideSuspension } from "@/server/api-v1/schemas";
import { decideSuspension } from "@/server/usecases/discipline";

type Ctx = { params: Promise<{ id: string }> };

/** Confirm (→ active), waive, or adjust a suspension (SPEC-1). */
export async function PATCH(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, DecideSuspension);
    const auth = await requireResourceAuth(req, "suspension", id, "write");
    const action =
      body.kind === "adjust"
        ? {
            kind: "adjust" as const,
            ...(body.matches_total !== undefined ? { matchesTotal: body.matches_total } : {}),
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
          }
        : { kind: body.kind };
    return decideSuspension(auth, id, action);
  });
}
