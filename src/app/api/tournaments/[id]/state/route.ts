import { handler } from "@/lib/http";
import { loadState } from "@/lib/tournament";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const state = await loadState(id);
    if (!state) throw new Error("Tournament not found");
    return state;
  });
}
