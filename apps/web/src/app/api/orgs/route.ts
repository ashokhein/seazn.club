import { createOrgForUser, getUserOrgs, requireUser, setActiveOrgId } from "@/lib/auth";
import { handler } from "@/lib/http";
import { createOrgSchema } from "@/lib/types";

/** List the organizations the current user belongs to (with their role). */
export async function GET() {
  return handler(async () => {
    const user = await requireUser();
    return getUserOrgs(user.id);
  });
}

/** Create a new organization; the creator becomes its owner. Slug is auto. */
export async function POST(req: Request) {
  return handler(async () => {
    const user = await requireUser();
    const { name } = createOrgSchema.parse(await req.json());
    const org = await createOrgForUser(user.id, name);
    await setActiveOrgId(org.id);
    return org;
  });
}
