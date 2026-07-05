import { v1, reply } from "@/server/api-v1/http";
import { requireFixtureActor } from "@/server/api-v1/auth";
import { getFixtureState } from "@/server/usecases/fixtures";

type Ctx = { params: Promise<{ id: string }> };

/** Live state (summary + fold + status). ETag = ledger seq (doc 08 §6). */
export async function GET(req: Request, { params }: Ctx) {
  const { id } = await params;
  let etag: string | undefined;
  const res = await v1(async () => {
    const auth = await requireFixtureActor(req, id, "read");
    const state = await getFixtureState(auth, id);
    etag = `"seq-${state.last_seq}"`;
    return reply(200, state, { ETag: etag });
  });
  if (etag && req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }
  return res;
}
