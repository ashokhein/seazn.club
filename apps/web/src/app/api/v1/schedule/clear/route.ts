import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ClearScheduleInput, clearScheduleScoped } from "@/server/usecases/history";

/** Scoped clear (Jul3/03 §5) — requires confirm: true; locked + decided rows
 *  always survive; fully undoable. */
export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, ClearScheduleInput);
    const auth = await requireResourceAuth(req, "division", body.division_id, "write");
    return clearScheduleScoped(auth, body);
  });
}
