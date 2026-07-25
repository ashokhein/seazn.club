import { z } from "zod";
import { handler } from "@/lib/http";
import { createSizePackCheckout } from "@/server/usecases/size-pack-checkout";

const schema = z
  .object({ competitionId: z.string().uuid(), sizePackKey: z.string().min(1) })
  .strict();

/** POST /api/billing/size-pack-checkout — start an EMBEDDED one-time size-pack
 *  checkout for a single competition (v17 SPEC-2 §3, Phase 3 Task 3b) and
 *  return its client_secret. Same embedded_page + reconcile-on-return contract
 *  as the Event Pass checkout; the purchase gate lives in the usecase. */
export async function POST(req: Request) {
  return handler(async () => {
    const { competitionId, sizePackKey } = schema.parse(await req.json());
    const session = await createSizePackCheckout({ competitionId, sizePackKey, req });
    return { client_secret: session.client_secret };
  });
}
