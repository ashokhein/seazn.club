import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { ShiftInput, shiftDivisionSchedule } from "@/server/usecases/schedule-plus";

/** Bulk time shift (Jul3/04 §4): push all pitches back N minutes at once.
 *  One schedule_shifted ledger event; undoable. All plans. */
export async function POST(req: Request) {
  return v1(async () => {
    const body = await parseBody(req, ShiftInput);
    const auth = await requireResourceAuth(req, "division", body.division_id, "write");
    return shiftDivisionSchedule(auth, body);
  });
}
