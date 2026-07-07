import { v1, parseBody } from "@/server/api-v1/http";
import { requireResourceAuth } from "@/server/api-v1/auth";
import { OverrideStandings } from "@/server/api-v1/schemas";
import { overrideStandings } from "@/server/usecases/stages";

type Ctx = { params: Promise<{ id: string }> };

/** Manual rank override (Jul3/05 §4): pin ranks (placement games decide
 *  3rd/4th); the cascade orders only the unlocked remainder. Pro
 *  `tiebreakers.custom`; audited as rank_overridden. */
export async function POST(req: Request, { params }: Ctx) {
  return v1(async () => {
    const { id } = await params;
    const body = await parseBody(req, OverrideStandings);
    const auth = await requireResourceAuth(req, "stage", id, "write");
    return overrideStandings(auth, id, body);
  });
}
