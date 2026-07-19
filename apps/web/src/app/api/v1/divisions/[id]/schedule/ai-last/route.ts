import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { lastAiApply } from "@/server/usecases/schedule";

type Ctx = { params: Promise<{ id: string }> };

/** GET /divisions/{id}/schedule/ai-last — recall the division's most recent
 *  AI-sourced schedule apply (v4/03 §10): the trimmed instruction + human
 *  summary + timestamp, or null when the AI Architect has never scheduled it.
 *  Read-only; all plans (the recall surfaces provenance already in the ledger). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "division", id, "read");
    return lastAiApply(auth, id);
  });
}
