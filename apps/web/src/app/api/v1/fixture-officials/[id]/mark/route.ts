import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutMarkBody } from "@/server/api-v1/schemas";
import { deleteMark, putMark } from "@/server/usecases/official-marks";

type Ctx = { params: Promise<{ id: string }> };

/** Rate an accepted, decided assignment (SPEC-3, console). Pro `officials.marks`
 *  in the usecase; the mark window (accepted + decided/finalized) is enforced
 *  there too. Upsert — one mark per assignment, editable forever. */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, PutMarkBody);
    const auth = await requireResourceAuth(req, "fixture_official", id, "write");
    await putMark(auth, id, body);
    return reply(204, null);
  });
}

/** Clear the mark (idempotent). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "fixture_official", id, "write");
    await deleteMark(auth, id);
    return reply(204, null);
  });
}
