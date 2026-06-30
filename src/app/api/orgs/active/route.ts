import { getOrgRole, requireUser, setActiveOrgId } from "@/lib/auth";
import { handler } from "@/lib/http";
import { setActiveOrgSchema } from "@/lib/types";

/** Switch the active board (org) — only to one the user belongs to. */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { org_id } = setActiveOrgSchema.parse(await req.json());
    const role = await getOrgRole(org_id, user.id);
    if (!role) throw new Error("You are not a member of this organization");
    await setActiveOrgId(org_id);
    return { ok: true };
  });
}
