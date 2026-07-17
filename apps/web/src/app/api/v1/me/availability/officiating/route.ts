import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireUser } from "@/lib/auth";
import { HttpError } from "@/lib/errors";
import { OfficiatingBlackoutInput } from "@/server/api-v1/schemas";
import { deleteMyBlackout, setMyBlackout } from "@/server/usecases/me-officiating";

/** Mark a blackout date (PROMPT-57): "can't do Sunday" applies to every
 *  officiating profile linked to the caller. Upsert on note. */
export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, OfficiatingBlackoutInput);
    const user = await requireUser();
    return reply(201, await setMyBlackout(user.id, body.date, body.note));
  });
}

/** Clear a blackout date (?date=YYYY-MM-DD, idempotent). */
export async function DELETE(req: Request) {
  return v1(async () => {
    const date = new URL(req.url).searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HttpError(400, "Invalid date — expected ?date=YYYY-MM-DD");
    }
    const user = await requireUser();
    await deleteMyBlackout(user.id, date);
    return { deleted: true };
  });
}
