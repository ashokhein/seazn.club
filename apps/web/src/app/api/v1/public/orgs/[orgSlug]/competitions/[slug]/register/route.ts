import { v1, parseBody, reply } from "@/server/api-v1/http";
import { rateLimit } from "@/lib/rate-limit";
import { baseUrl } from "@/lib/oauth";
import { HttpError } from "@/lib/errors";
import { PublicRegisterRequest } from "@/server/api-v1/schemas";
import { submitRegistration } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

/** Public registration submit (doc 16 §1.1). Tighter per-IP limit than the
 *  general public read budget — it's a write. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    await rateLimit(`regsubmit:${ip}`, { max: 10, windowSeconds: 60 });
    const { orgSlug, slug } = await params;
    const input = await parseBody(req, PublicRegisterRequest);
    // Honeypot (v3/05 §4): the visible form never fills `website`.
    if (input.website) {
      throw new HttpError(400, "Registration failed");
    }
    // Second bucket per IP+division (v3/05 §4): one address hammering a
    // single division throttles harder than the general write budget above.
    await rateLimit(`regsubmit:${ip}:${input.division_id}`, { max: 5, windowSeconds: 300 });
    const result = await submitRegistration(orgSlug, slug, input, baseUrl(req));
    return reply(201, {
      registration_id: result.registration.id,
      status: result.registration.status,
      access_token: result.access_token,
      checkout_url: result.checkout_url,
    });
  });
}
