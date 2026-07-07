import { z } from "zod";
import { v1, parseBody } from "@/server/api-v1/http";
import { requireAuth } from "@/server/api-v1/auth";
import { previewDivisionFixtures } from "@/server/usecases/stages";

const Body = z.object({
  count: z.number().int().min(2).max(64).default(8),
  stages: z
    .array(
      z.object({
        kind: z.string().min(1),
        name: z.string().min(1).max(80),
        config: z.record(z.string(), z.unknown()).default({}),
        qualification: z.unknown().nullable().default(null),
      }),
    )
    .min(1)
    .max(4),
});

/** Example-fixture preview for the division builder — runs the real engine draw
 *  over placeholder entrants (no persistence). Any signed-in member. */
export async function POST(req: Request) {
  return v1(async () => {
    await requireAuth(req, "read");
    const body = await parseBody(req, Body);
    return { phases: previewDivisionFixtures(body.stages, body.count) };
  });
}
