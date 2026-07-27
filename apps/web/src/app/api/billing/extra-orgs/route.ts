import { z } from "zod";
import { handler } from "@/lib/http";
import { MAX_EXTRA_ORGS, setExtraOrgs } from "@/server/usecases/extra-orgs";

// Bound taken FROM the usecase rather than restated: a schema that said 50
// while the usecase said something else would refuse with a Zod 400 whose
// shape (`issues`) differs from the usecase's own 400, and the client's
// status -> message mapping would have two doors into one failure.
const schema = z.object({ count: z.number().int().min(0).max(MAX_EXTRA_ORGS) }).strict();

/**
 * POST /api/billing/extra-orgs — add / adjust / remove the recurring
 * extra-organisation add-on ($9/mo Pro, $19/mo Pro Plus, +1 orgs.max_owned
 * each, GROUP-WIDE) for the caller's billing group (v17 gap #293).
 *
 * `count` is the TOTAL the group should hold, not a delta; 0 removes the
 * add-on. Group-payer gated inside setExtraOrgs (requireBillingOwner) — a
 * non-payer gets 403 before any Stripe call. The org_addons row is written by
 * the customer.subscription.updated webhook, never here.
 *
 * The client must map STATUS to a localised message (400 bad count / 401 signed
 * out / 403 not the payer / 409 group cannot hold the add-on / 503 catalog not
 * synced) — see setExtraOrgs' doc comment. The `error` string in the body is
 * hardcoded English for logs and must not be rendered into the four-locale UI.
 */
export async function POST(req: Request) {
  return handler(async () => {
    const { count } = schema.parse(await req.json());
    return setExtraOrgs(count);
  });
}
