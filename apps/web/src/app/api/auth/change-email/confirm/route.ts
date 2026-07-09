import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { invalidateUser } from "@/lib/auth";

/**
 * Confirm an email-address change via the token link sent to the new address.
 * Redirects to /settings?tab=account on success or failure.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";

  try {
    const [row] = await sql<{
      id: string;
      user_id: string;
      new_email: string;
      expires_at: string;
      confirmed: boolean;
    }[]>`
      select id, user_id, new_email, expires_at, confirmed
      from email_change_requests where token = ${token} limit 1`;

    if (!row) {
      return NextResponse.redirect(
        new URL("/settings?tab=account&email_change=invalid", req.url),
      );
    }
    if (row.confirmed || new Date(row.expires_at) < new Date()) {
      return NextResponse.redirect(
        new URL("/settings?tab=account&email_change=expired", req.url),
      );
    }

    // Check the new address is still unclaimed (race protection)
    const [taken] = await sql<{ id: string }[]>`
      select id from users where lower(email) = lower(${row.new_email})
      and id <> ${row.user_id} limit 1`;
    if (taken) {
      await sql`delete from email_change_requests where id = ${row.id}`;
      return NextResponse.redirect(
        new URL("/settings?tab=account&email_change=taken", req.url),
      );
    }

    await sql.begin(async (tx) => {
      await tx`update users set email = ${row.new_email} where id = ${row.user_id}`;
      await tx`update email_change_requests set confirmed = true where id = ${row.id}`;
    });
    await invalidateUser(row.user_id);

    return NextResponse.redirect(
      new URL("/settings?tab=account&email_change=success", req.url),
    );
  } catch {
    return NextResponse.redirect(
      new URL("/settings?tab=account&email_change=error", req.url),
    );
  }
}
