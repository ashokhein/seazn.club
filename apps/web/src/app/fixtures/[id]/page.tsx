export const dynamic = "force-dynamic";
// Legacy id route — 301s to the slug chain (PROMPT-30). Delete once the
// [legacy-route] log line goes quiet (keep >= 2 releases).
import { permanentRedirect } from "next/navigation";
import { legacyPath } from "@/server/legacy-routes";

export default async function Legacy({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  permanentRedirect(await legacyPath("fixture", id));
}
