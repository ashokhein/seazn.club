import { v1, reply, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateSuspension } from "@/server/api-v1/schemas";
import {
  createManualSuspension,
  listSuspensions,
  type SuspensionStatus,
} from "@/server/usecases/discipline";

type Ctx = { params: Promise<{ id: string }> };

const STATUSES = new Set(["pending", "active", "served", "waived"]);

/** List suspensions in the division, optionally filtered by ?status= (SPEC-1). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    const raw = new URL(req.url).searchParams.get("status");
    const status = raw && STATUSES.has(raw) ? (raw as SuspensionStatus) : undefined;
    return listSuspensions(auth, id, status);
  });
}

/** Record a manual suspension (pending until the organiser confirms it). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    const body = await parseBody(req, CreateSuspension);
    const created = await createManualSuspension(auth, id, {
      personId: body.person_id,
      matchesTotal: body.matches_total,
      reason: body.reason,
    });
    return reply(201, created);
  });
}
