import { handler } from "@/lib/http";
import { consumePasswordReset } from "@/lib/password-reset";
import { z } from "zod";

const schema = z.object({
  token: z.string().min(1),
  password: z.string().min(6).max(100),
}).strict();

export async function POST(req: Request) {
  return handler(async () => {
    const { token, password } = schema.parse(await req.json());
    await consumePasswordReset(token, password);
    return { ok: true };
  });
}
