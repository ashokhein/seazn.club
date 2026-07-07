import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { HistoryStepInput, redoDivision } from "@/server/usecases/history";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, HistoryStepInput);
    const auth = await requireResourceAuth(req, "division", id, "write");
    return redoDivision(auth, id, body.expected_seq);
  });
}
