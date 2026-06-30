import "server-only";
import { supabaseAdmin } from "@/lib/supabase-admin";

const ASSETS_BUCKET = "assets";

/**
 * Generate a signed upload URL for direct browser → Supabase Storage upload.
 * The caller must PUT the file bytes directly to the returned `url`.
 * After upload, store `storagePath` in the DB.
 */
export async function getSignedUploadUrl(
  storagePath: string,
  expiresIn = 300,
): Promise<{ url: string; token: string }> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.storage
    .from(ASSETS_BUCKET)
    .createSignedUploadUrl(storagePath, { upsert: true });
  if (error || !data) throw new Error(`Storage upload URL failed: ${error?.message}`);
  return { url: data.signedUrl, token: data.token };
}

/**
 * Public CDN URL for a stored asset.
 * Use this to render images — served from Supabase CDN, not Vercel.
 */
export function publicStorageUrl(storagePath: string): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return "";
  return `${url}/storage/v1/object/public/${ASSETS_BUCKET}/${storagePath}`;
}

/**
 * Delete an object from storage. Fire-and-forget — used when replacing or
 * removing an avatar/logo.
 */
export async function deleteStorageObject(storagePath: string): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb.storage.from(ASSETS_BUCKET).remove([storagePath]);
  if (error) console.warn(`[storage] delete failed for ${storagePath}:`, error.message);
}

/**
 * Player avatar storage path — scoped to org + tournament + player UUID.
 */
export function playerAvatarPath(
  orgId: string,
  tournamentId: string,
  playerId: string,
): string {
  return `orgs/${orgId}/tournaments/${tournamentId}/players/${playerId}.webp`;
}

/**
 * Org logo storage path — scoped to org.
 */
export function orgLogoPath(orgId: string): string {
  return `orgs/${orgId}/branding/logo.webp`;
}

/**
 * Resolve display URL for a player image:
 * - If image_storage_path set → CDN URL
 * - Else if image_url is an https URL → use directly
 * - Else (data URL or null) → null (Avatar component handles initials fallback)
 */
export function resolvePlayerImageUrl(
  imageStoragePath: string | null,
  imageUrl: string | null,
): string | null {
  if (imageStoragePath) return publicStorageUrl(imageStoragePath);
  if (imageUrl?.startsWith("https://")) return imageUrl;
  return null; // data URLs excluded — Avatar falls back to initials
}
