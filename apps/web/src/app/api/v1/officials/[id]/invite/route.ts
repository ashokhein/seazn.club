import { v1, parseBody, reply } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { CreateClaimInvite } from "@/server/api-v1/schemas";
import { inviteOfficial } from "@/server/usecases/officials";
import { sendOfficialInviteEmail } from "@/lib/email";
import { routes } from "@/lib/routes";
import { baseUrl } from "@/lib/oauth";

type Ctx = { params: Promise<{ id: string }> };

/** Invite the official to claim their profile (PROMPT-57). The SHARED
 *  person-claim rail does the work — this route only points it at the
 *  official's person (created on demand) and sends officiating copy.
 *  Session editors only (enforced in the claim usecase); the claim_url
 *  embeds the one-time secret. Email is best-effort — the console keeps
 *  the copyable link as fallback. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const { email } = await parseBody(req, CreateClaimInvite);
    const auth = await requireResourceAuth(req, "official", id, "write");
    const { claim, secret, person_name, org_name } = await inviteOfficial(auth, id, email);
    const claim_url = `${baseUrl(req)}${routes.claim(secret)}`;
    const email_sent = await sendOfficialInviteEmail(email, {
      orgName: org_name,
      personName: person_name,
      claimUrl: claim_url,
    });
    return reply(201, { ...claim, claim_url, email_sent });
  });
}
