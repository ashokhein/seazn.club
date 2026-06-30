import { destroySession } from "@/lib/auth";
import { handler } from "@/lib/http";

export async function POST() {
  return handler(async () => {
    await destroySession();
    return { ok: true };
  });
}
