import { z } from "zod";
import { v1, parseBody, reply } from "@/server/api-v1/http";
import { rateLimit } from "@/lib/rate-limit";
import { withdrawRegistrationByRef } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ ref: string }> };

const Body = z.object({ token: z.string().min(1) });

/** Self-withdraw from /r/[ref] (v3/05 §3) — ref locates, token authorises. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`regwithdraw:${ip}`, { max: 10, windowSeconds: 60 });
    const { ref } = await params;
    const { token } = await parseBody(req, Body);
    return reply(200, await withdrawRegistrationByRef(decodeURIComponent(ref), token));
  });
}
