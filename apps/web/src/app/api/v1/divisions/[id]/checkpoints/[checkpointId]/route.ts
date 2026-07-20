import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { deleteCheckpoint } from "@/server/usecases/history";

type Ctx = { params: Promise<{ id: string; checkpointId: string }> };

/** DELETE /api/v1/divisions/{id}/checkpoints/{checkpointId} — drop a save
 *  point. Deleting a manual one frees a `schedule.checkpoints.max` slot; before
 *  this there was no way to reclaim one. */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id, checkpointId } = await params;
    const auth = await requireResourceAuth(req, "division", id, "write");
    await deleteCheckpoint(auth, id, checkpointId);
    return { deleted: true };
  });
}
