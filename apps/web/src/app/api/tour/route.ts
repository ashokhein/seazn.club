import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { markTourDone, resetTour } from "@/lib/activation";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await markTourDone(user.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await resetTour(user.id);
  return NextResponse.json({ ok: true });
}
