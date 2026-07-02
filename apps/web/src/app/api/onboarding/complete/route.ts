import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { markOnboardingDone } from "@/lib/activation";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await markOnboardingDone(user.id);
  return NextResponse.json({ ok: true });
}
