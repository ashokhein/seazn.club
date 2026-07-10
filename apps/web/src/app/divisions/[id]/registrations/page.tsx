export const dynamic = "force-dynamic";
// Legacy id route — 301s to the slug chain, forwarding the query string
// (PROMPT-30). Delete once the [legacy-route] log line goes quiet.
import { permanentRedirect } from "next/navigation";
import { legacyPath } from "@/server/legacy-routes";

export default async function Legacy({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const qs = new URLSearchParams(
    Object.entries(sp).flatMap(([k, v]) =>
      v === undefined ? [] : Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
    ) as [string, string][],
  ).toString();
  const path = await legacyPath("division", id, "/registrations");
  permanentRedirect(qs ? `${path}?${qs}` : path);
}
