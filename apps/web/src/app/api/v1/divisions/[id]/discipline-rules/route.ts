import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutDisciplineRules } from "@/server/api-v1/schemas";
import { getDisciplineRules, putDisciplineRules } from "@/server/usecases/discipline";

type Ctx = { params: Promise<{ id: string }> };

/** Discipline rules + enabled flag (null when the sport has no card model);
 *  Pro `discipline.enforced` (SPEC-1). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return getDisciplineRules(auth, id);
  });
}

/** Upsert the rules doc + enabled flag; colours validated against the module. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const body = await parseBody(req, PutDisciplineRules);
    await putDisciplineRules(auth, id, body);
    return getDisciplineRules(auth, id);
  });
}
