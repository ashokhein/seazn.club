import { requireSuperadmin, logStaffAction } from "@/lib/admin";
import { handler } from "@/lib/http";
import { platformFeeDefault, setPlatformFeeDefault } from "@/lib/platform-settings";
import { z } from "zod";

/** GET /api/admin/settings — platform-wide knobs (superadmin). */
export async function GET() {
  return handler(async () => {
    await requireSuperadmin();
    return { platform_fee_percent: await platformFeeDefault() };
  });
}

const putSchema = z.object({
  platform_fee_percent: z.number().min(0).max(100),
}).strict();

/** PUT /api/admin/settings — update the platform fee default (superadmin). */
export async function PUT(req: Request) {
  return handler(async () => {
    const staff = await requireSuperadmin();
    const { platform_fee_percent } = putSchema.parse(await req.json());
    await setPlatformFeeDefault(platform_fee_percent, staff.id);
    await logStaffAction(staff.id, "platform_fee_default_set", "platform", "platform_fee_percent", {
      platform_fee_percent,
    });
    return { platform_fee_percent: await platformFeeDefault() };
  });
}
