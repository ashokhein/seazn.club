import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateClaimInvite } from "@/server/api-v1/schemas";
import {
  createClaimInvite,
  getOpenClaim,
  revokeClaimInvite,
} from "@/server/usecases/person-claims";
import { sendClaimInviteEmail } from "@/lib/email";
import { routes } from "@/lib/routes";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

/** Invite the person to claim their profile (PROMPT-53). Session editors
 *  only (enforced in the usecase); the claim_url embeds the one-time secret.
 *  Email delivery is best-effort — the console shows the copyable link + QR. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const { email } = await parseBody(req, CreateClaimInvite);
    const auth = await requireResourceAuth(req, "person", id, "write");
    const { secret, person_name, org_name, ...claim } = await createClaimInvite(auth, id, email);
    const claim_url = `${baseUrl(req)}${routes.claim(secret)}`;
    await sendClaimInviteEmail(email, { orgName: org_name, personName: person_name, claimUrl: claim_url });
    return reply(201, { ...claim, claim_url });
  });
}

/** The person's open invite, if any (no secret — it showed once). */
export async function GET(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "read");
    return getOpenClaim(auth, id);
  });
}

/** Withdraw the open invite (idempotent). */
export async function DELETE(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const auth = await requireResourceAuth(req, "person", id, "write");
    return revokeClaimInvite(auth, id);
  });
}
