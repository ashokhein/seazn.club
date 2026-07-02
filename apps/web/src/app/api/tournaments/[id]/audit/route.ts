import { sql } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handler } from "@/lib/http";
import type { AuditEntry } from "@/lib/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handler(async () => {
    await requireUser();
    const { id } = await params;
    const rows = await sql<AuditEntry[]>`
      select id, tournament_id, actor, action, summary, detail, created_at
      from audit_log
      where tournament_id = ${id}
      order by created_at desc, id desc
      limit 200`;
    return rows;
  });
}
