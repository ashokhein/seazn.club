import { sql } from "@/lib/db";
import { requireStaff, createImpersonationToken } from "@/lib/admin";
import { handler, HttpError } from "@/lib/http";
import { baseUrl } from "@/lib/oauth";

/**
 * Create a 1-hour read-only impersonation session.
 * Returns a one-time URL the staff member opens in a new tab.
 * Support or superadmin only.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    const { id } = await params;
    const staff = await requireStaff();

    if (staff.id === id) throw new HttpError(400, "Cannot impersonate yourself");

    const [user] = await sql<{ id: string; is_staff: boolean }[]>`
      select id, is_staff from users where id = ${id} and deleted_at is null`;
    if (!user) throw new HttpError(404, "User not found");
    if (user.is_staff) throw new HttpError(403, "Cannot impersonate staff accounts");

    const token = await createImpersonationToken(staff.id, id);
    const url = `${baseUrl(req)}/admin/impersonate?token=${token}`;
    return { url };
  });
}
