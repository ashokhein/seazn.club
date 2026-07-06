import { v1 } from "@/server/api-v1/http";
import { publicRateLimit } from "@/server/usecases/public";
import { publicRegistrationInfo } from "@/server/usecases/registrations";

type Ctx = { params: Promise<{ orgSlug: string; slug: string }> };

/** Public register panel: divisions open for registration, fees, remaining
 *  capacity, form definition (doc 16 §1.1). Uncached — capacity is live. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    await publicRateLimit(req);
    const { orgSlug, slug } = await params;
    return publicRegistrationInfo(orgSlug, slug);
  });
}
