import { z } from "zod";
import { handler } from "@/lib/http";
import { HttpError } from "@/lib/errors";
import { setExtraOrgs } from "@/server/usecases/extra-orgs";

// Shape only. The numeric bound lives in setExtraOrgs (MAX_EXTRA_ORGS) and is
// NOT restated here: two copies of the edge could disagree, and a Zod failure
// would answer with a different status from the usecase's own refusal.
const schema = z.object({ count: z.number() }).strict();

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
 * The client must map STATUS to a localised message — see setExtraOrgs' doc
 * comment for the full table. The `error` string in the body is hardcoded
 * English for logs and must not be rendered into the four-locale UI.
 */
export async function POST(req: Request) {
  return handler(async () => {
    let count: number;
    try {
      ({ count } = schema.parse(await req.json()));
    } catch {
      // ANY failure in this block is a malformed request body, and there are
      // two distinct ways to get one: `schema.parse` throws ZodError for a
      // wrong-typed or unknown field, and `req.json()` throws SyntaxError for
      // a truncated or non-JSON body. Testing for ZodError alone let the
      // SyntaxError through to `handler`'s unknown branch — a 500 plus a
      // Sentry capture, i.e. a client sending junk could page someone.
      //
      // Catching everything is safe *because* this block does nothing but
      // parse input: no DB, no Stripe, no business logic whose genuine failure
      // could be swallowed here.
      //
      // 422 rather than 400 because `handler` maps a raw ZodError to 400, and
      // on this endpoint 400 is reserved for "reselect an organisation" — this
      // keeps the promise that a 400 from here ALWAYS means org state.
      throw new HttpError(422, "extra organisations must be a number.");
    }
    return setExtraOrgs(count);
  });
}
