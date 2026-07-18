// Client-safe public-URL builder for the assets bucket. Deliberately free of
// "server-only": resolveEntrantBadge runs in client components (entrants
// panel badge control), and NEXT_PUBLIC_* is inlined into the client bundle.
// Everything that needs the admin client stays in supabase-storage.ts.
export const ASSETS_BUCKET = "assets";

export function publicStorageUrl(storagePath: string): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "";
  return `${url}/storage/v1/object/public/${ASSETS_BUCKET}/${storagePath}`;
}
