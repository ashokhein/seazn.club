import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { PutScheduleSettings } from "@/server/api-v1/schemas";
import { getScheduleSettings, putScheduleSettings } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** Division scheduling settings (doc 12 §3/§4). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return getScheduleSettings(auth, id);
  });
}

/** Upsert the calendar-pass inputs; constraint fields are Pro (doc 12 §5). */
export async function PUT(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const input = await parseBody(req, PutScheduleSettings);
    return putScheduleSettings(auth, id, input);
  });
}
