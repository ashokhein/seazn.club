import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import { acceptGroupTransfer } from "@/server/usecases/billing-groups";

const schema = z.object({ setup_intent_id: z.string().min(1) });

/**
 * POST /api/billing/group/transfer/accept — take over a billing group offered
 * to you, once you have confirmed the offer's SetupIntent with your own card.
 *
 * The caller is the RECIPIENT, not the outgoing payer, so this route cannot be
 * gated on the group's current owner: the SetupIntent's metadata names who the
 * offer was for, and the use case checks it against the session.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const body = schema.parse(await req.json());
    return acceptGroupTransfer({ actorUserId: user.id, setupIntentId: body.setup_intent_id });
  });
}
