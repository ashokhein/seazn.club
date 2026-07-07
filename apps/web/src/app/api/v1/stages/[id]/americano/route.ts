import { v1 } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { americanoView } from "@/server/usecases/americano";

type Ctx = { params: Promise<{ id: string }> };

/** Americano rotation grid + personal-points leaderboard (Jul3/08 §3). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "stage", id, "read");
    return americanoView(auth, id);
  });
}
