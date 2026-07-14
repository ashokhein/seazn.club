import { v1, parseBody } from "@/server/api-v1/http";
import { requireOrgAuth, assertUuid } from "@/server/api-v1/auth";
import { CreateConnectOnboarding } from "@/server/api-v1/schemas";
import { baseUrl } from "@/lib/oauth";
import {
  connectStatus,
  createConnectOnboardingLink,
} from "@/server/usecases/stripe-connect";

type Ctx = { params: Promise<{ id: string }> };

/** Stripe Connect status (?refresh=1 re-reads from Stripe — the
 *  return-from-onboarding reconcile). Owner-only inside the use-case. */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "read");
    const refresh = new URL(req.url).searchParams.get("refresh") === "1";
    return connectStatus(auth, id, refresh);
  });
}

/** Create the Express account (once) + mint an onboarding link (Pro). */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    assertUuid(id, "organization");
    const auth = await requireOrgAuth(req, id, "write");
    const input = await parseBody(req, CreateConnectOnboarding);
    return createConnectOnboardingLink(
      auth, id, baseUrl(req), input.return_path, input.tos_agreed,
    );
  });
}
