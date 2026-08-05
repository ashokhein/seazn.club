import { z } from "zod";
import { sql } from "@/lib/db";
import { requireSuperadmin, logStaffAction, DISCOVERY_CURATION_VERBS } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { hasFeature } from "@/lib/entitlements";
import {
  fireDiscoveryRevalidate,
  invalidateDiscoveryCache,
} from "@/server/public-site/revalidate";

const schema = z
  .object({
    // Derived, not retyped. The audited action below is `discovery_${action}`,
    // so this enum and DISCOVERY_AUDIT_ACTIONS (which the org adjustments-log
    // allowlist reads) are two views of one list — a fifth verb added here
    // fails the build in admin-adjustments-log.ts rather than quietly writing
    // an audit row nothing renders.
    action: z.enum(DISCOVERY_CURATION_VERBS),
    reason: z.string().min(1).max(500),
  })
  .strict();

/**
 * Discovery curation (doc 15 §3, PROMPT-19): staff-only featured flag
 * (Pro-eligible orgs only — eligible, not guaranteed) and the abuse block.
 * Every action lands in staff_audit_log with its reason.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireSuperadmin();
    const { action, reason } = schema.parse(await req.json());

    const [comp] = await sql<{ id: string; org_id: string }[]>`
      select id, org_id from competitions where id = ${id}`;
    if (!comp) throw new HttpError(404, "Competition not found");

    if (action === "feature" && !(await hasFeature(comp.org_id, "discovery.featured"))) {
      throw new HttpError(422, "Only Pro orgs are eligible for the featured row (doc 15 §3)");
    }

    if (action === "feature" || action === "unfeature") {
      await sql`update competitions
                set discovery_featured = ${action === "feature"} where id = ${id}`;
    } else {
      await sql`update competitions
                set discovery_blocked = ${action === "block"} where id = ${id}`;
    }

    await logStaffAction(staff.id, `discovery_${action}`, "org", comp.org_id, {
      reason,
      competition_id: id,
    });
    // Block/unblock must bite within the revalidation window (doc 15 §1).
    await invalidateDiscoveryCache();
    fireDiscoveryRevalidate();
    return { ok: true };
  });
}
