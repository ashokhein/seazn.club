import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { getStandings } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "read");
    const poolId = new URL(req.url).searchParams.get("pool_id") ?? undefined;
    return getStandings(auth, id, poolId);
  });
}
