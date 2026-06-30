# 11 — Supabase Storage for Assets

## 1. Goal

Replace inline **data-URL images** in the database with **Supabase Storage** for player
avatars, org logos, and (later) generated exports — using the same Supabase project as
Postgres and Realtime, direct-to-storage uploads from the browser, and no file proxying
through Vercel.

**Locked decision:** Supabase Storage — not S3/R2 as a separate vendor.

## 2. Current state

- `players.image_url` is a `text` column — either `null`, an external `https://` URL, or a
  **base64 data URL** embedded in Postgres (up to ~1.5 MB per Zod validation).
- `new-tournament-form.tsx` and `live-tournament.tsx` use `fileToDataUrl()` to downscale
  images client-side and store them inline — works for demos, bad for production (DB bloat,
  slow queries, no CDN).
- `Avatar` renders `src` as a plain `<img>` — any HTTPS or data URL works today.
- No org logo field yet; branding is a planned entitlement (`branding`, doc 01).
- No export file storage; CSV is client-side blob download only.

## 3. Why Supabase Storage (on Vercel)

| Approach | Fit |
|----------|-----|
| Store bytes in Postgres (data URLs) | ❌ Current hack; does not scale |
| Upload via Vercel API route | ❌ Body size limits; slow; costly |
| S3 / R2 + signed URLs | ✅ Works but second vendor + credentials |
| **Supabase Storage + signed upload URLs** | ✅ **Same project** as DB + Realtime; CDN; image transforms |

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                         │
│   1. POST /api/.../upload-url  →  { path, token }               │
│   2. PUT file → Supabase Storage (direct, no Vercel bytes)      │
│   3. PATCH player/org  →  store storage path in DB              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Supabase Storage                                                │
│   bucket: assets                                                 │
│   paths scoped by org_id / tournament_id                         │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  PostgreSQL (players.image_url / orgs.logo_path)                 │
│   stores path or public URL — not file bytes                     │
└─────────────────────────────────────────────────────────────────┘
```

**Reads:** `<img src={publicOrTransformUrl(path)}>` — served from Supabase CDN, not Vercel.

## 5. Buckets & path layout

### 5.1 Buckets

| Bucket | Visibility | Contents |
|--------|------------|----------|
| `assets` | **Public** (read) | Player avatars, org logos — cacheable, used on public pages |
| `exports` | **Private** | Generated CSV/PDF reports — signed download URLs only |

Start with **`assets`** in Phase 2; add `exports` when scheduled reports land (Phase 3).

### 5.2 Path conventions (tenant-scoped)

All paths **must** start with `orgs/{org_id}/` so storage policies can enforce tenancy.

```
assets/
  orgs/{org_id}/
    branding/
      logo.webp                          # org logo (branding entitlement)
    tournaments/{tournament_id}/
      players/{player_id}.webp           # player avatar
```

**Rules:**
- `{org_id}`, `{tournament_id}`, `{player_id}` are UUIDs from our DB.
- Extension normalized to `.webp` (or `.jpg`) after client-side resize.
- No user-supplied path segments — server generates the full path.
- Overwriting the same path replaces the object (avatar update).

### 5.3 What we store in Postgres

**Option A (recommended):** store **storage path** in a dedicated column; resolve URL at read time.

```sql
-- greenfield when implementing
ALTER TABLE players ADD COLUMN image_storage_path text;
ALTER TABLE organizations ADD COLUMN logo_storage_path text;
```

Keep `image_url` for backward compatibility:
- Legacy rows: `image_url` = data URL or external URL; `image_storage_path` = null.
- New uploads: `image_storage_path` = `orgs/.../players/....webp`; `image_url` = null or
  cached public URL.

**Option B (simpler v1):** write the **public URL** directly into `image_url` after upload.
Less flexible for transforms; acceptable for first ship.

**Resolver helper** (`src/lib/assets.ts`):

```ts
const STORAGE_PUBLIC_BASE =
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/assets`;

export function assetPublicUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("data:") || path.startsWith("http")) return path; // legacy
  return `${STORAGE_PUBLIC_BASE}/${path}`;
}

export function assetTransformUrl(
  path: string,
  opts: { width: number; height: number },
): string {
  // Supabase image transformation (Pro plan on Supabase; verify at implementation)
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return `${base}/storage/v1/render/image/public/assets/${path}?width=${opts.width}&height=${opts.height}&resize=cover`;
}
```

Use transform URLs in `Avatar` for consistent thumbnail sizes.

## 6. Environment variables

Same Supabase project as doc 10 — no extra vendor:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...    # mint upload URLs, delete objects, exports
```

Optional:

```bash
NEXT_PUBLIC_ASSETS_BUCKET=assets
ASSETS_MAX_BYTES=2097152              # 2 MiB
ASSETS_ALLOWED_TYPES=image/jpeg,image/png,image/webp
```

## 7. Upload flow (signed upload URL)

We keep **custom cookie auth** for the app. Storage uploads use a **server-minted signed
upload URL** (service role) — the browser never gets the service role key.

### 7.1 Sequence

```
Client                    API (Vercel)                 Supabase Storage
  │                            │                              │
  │── POST upload-url ────────▶│ verify session + entitlement │
  │    { kind, entity_id }     │ validate mime/size intent    │
  │                            │── createSignedUploadUrl ────▶│
  │◀── { path, token } ────────│                              │
  │                            │                              │
  │── PUT file (token) ──────────────────────────────────────▶│
  │                            │                              │
  │── PATCH player/logo ──────▶│ store path in DB             │
  │                            │── publishTournamentUpdate ──▶│ (doc 10, if live)
```

### 7.2 API routes (new)

| Route | Purpose |
|-------|---------|
| `POST /api/orgs/[id]/assets/upload-url` | Org logo upload (`kind: 'org_logo'`) |
| `POST /api/tournaments/[id]/players/[playerId]/upload-url` | Player avatar (`kind: 'player_avatar'`) |

**Request body:**

```ts
const UploadUrlRequest = z.object({
  kind: z.enum(["org_logo", "player_avatar"]),
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  content_length: z.number().int().min(1).max(2_097_152),
});
```

**Response:**

```ts
{
  path: "orgs/{orgId}/tournaments/{tid}/players/{pid}.webp",
  token: "...",           // signed upload token from Supabase
  public_url: "https://.../storage/v1/object/public/assets/..."
}
```

### 7.3 Server implementation sketch

```ts
// src/lib/storage.ts (server-only)
import "server-only";
import { supabaseAdmin } from "./supabase-admin";

export async function createAssetUploadUrl(path: string) {
  const { data, error } = await supabaseAdmin()
    .storage
    .from("assets")
    .createSignedUploadUrl(path, { upsert: true });
  if (error) throw error;
  return data;
}
```

After client upload, `PATCH` the entity to persist `image_storage_path` (or `logo_storage_path`).

### 7.4 Client upload

Reuse existing **client-side resize** (`fileToDataUrl` logic) but output a `Blob` instead
of a data URL, then:

```ts
const blob = await fileToWebpBlob(file, 256); // max dimension 256px for avatars
await fetch(signedUrl, {
  method: "PUT",
  headers: { "Content-Type": "image/webp" },
  body: blob,
});
```

Org logos may allow larger dimensions (e.g. 512px) under `branding` entitlement.

## 8. Entitlements

| Asset | Entitlement | Community fallback |
|-------|-------------|-------------------|
| Player avatar (storage) | Pro+ (`branding` or a new `assets` key — recommend reusing Pro tier generally) | Keep data-URL inline upload OR initials only |
| Org logo | `branding` (Pro+) | No logo; default product branding |
| Export files (`exports` bucket) | `exports` (Pro+) | Client-side CSV only (current) |

Enforce on `upload-url` routes:

```ts
await requireFeature(orgId, "branding"); // for logos
// Player avatars: require paid plan or allow limited count on Community — product choice:
await requireFeature(orgId, "branding"); // simplest: same gate as logos for Pro+
```

Show upgrade prompt in UI when user picks an image on Community.

## 9. Storage policies (Supabase dashboard)

### 9.1 `assets` bucket — public read, restricted write

- **SELECT (public):** allow anonymous read on `assets` bucket (public tournament pages need
  avatars without auth). Acceptable for sports event photos; orgs can use initials if concerned.
- **INSERT/UPDATE:** only via **signed upload URLs** minted server-side (service role) — do
  not expose open client write with anon key.
- **DELETE:** service role only (server cleanup when player removed / org deleted).

### 9.2 `exports` bucket — private

- No public read. Downloads via `createSignedUrl(path, expiresIn)` from server after
  `exports` entitlement check.

### 9.3 Tenant isolation

Upload-url handler **constructs paths server-side** from verified `org_id` / `tournament_id`
/ `player_id` — never trust client-provided paths.

## 10. Lifecycle & cleanup

| Event | Action |
|-------|--------|
| Player removed | Delete `assets/.../players/{player_id}.*` (best-effort, async job) |
| Tournament deleted | Delete prefix `.../tournaments/{tournament_id}/` |
| Org deleted (GDPR) | Delete prefix `orgs/{org_id}/` in both buckets |
| Avatar replaced | `upsert: true` on upload overwrites same path |

Use a background job (doc 02 queue) for prefix deletes — don't block API responses.

## 11. Security

| Risk | Mitigation |
|------|------------|
| Service role leak | Server-only; never `NEXT_PUBLIC_*` |
| Arbitrary file upload | Allowlist image MIME; max bytes; client resize; magic-byte check server-side on confirm `LATER` |
| Cross-tenant path write | Server generates paths from authorized entity ids only |
| Malicious image (EXIF, polyglot) | Strip via canvas re-encode client-side; optional Sharp in worker `LATER` |
| Hotlinking / abuse | Public bucket is fine for avatars; rate-limit upload-url minting per org |
| XSS via SVG | **Reject SVG** — raster only (jpeg/png/webp) |

## 12. UI changes

### 12.1 Shared component: `ImageUploadField`

Extract from `new-tournament-form.tsx`:

```tsx
<ImageUploadField
  label="Photo"
  currentUrl={assetPublicUrl(player.image_storage_path ?? player.image_url)}
  onUpload={async (file) => { /* upload-url → PUT → PATCH */ }}
  disabled={!canUpload}
  upgradeHint={!hasBranding ? "Upgrade to Pro to add photos" : undefined}
/>
```

Use in:
- `new-tournament-form.tsx` (create flow)
- `live-tournament.tsx` setup view (add player)
- `settings` org branding panel (logo)

### 12.2 `Avatar` component

```tsx
<Avatar name={name} src={assetTransformUrl(path, { width: size*2, height: size*2 }) ?? legacyUrl} size={size} />
```

Add `loading="lazy"` and `decoding="async"` for slideshow grids.

## 13. Backward compatibility

**No forced migration** of existing data URLs:

1. `assetPublicUrl()` returns data URLs and external URLs unchanged.
2. New uploads on Pro+ go to Storage.
3. Optional background job later: detect large `image_url` data URLs → re-upload to Storage →
   clear inline data (reduces DB size).

## 14. Exports bucket (`LATER`, Phase 3)

When adding server-generated exports:

```
exports/orgs/{org_id}/reports/{report_id}.pdf
```

- Worker writes file with service role.
- User downloads via `GET /api/orgs/[id]/exports/[reportId]/download` → short-lived signed URL.
- Entitlement: `exports`.

## 15. Module layout

```
src/lib/
  supabase-admin.ts     # shared with doc 10
  storage.ts            # createAssetUploadUrl, deletePrefix, signedDownload (server-only)
  assets.ts             # assetPublicUrl, assetTransformUrl (shared client + server)

src/app/api/
  orgs/[id]/assets/upload-url/route.ts
  tournaments/[id]/players/[playerId]/upload-url/route.ts
  orgs/[id]/exports/[reportId]/download/route.ts   # LATER
```

## 16. Testing

### 16.1 Smoke (`scripts/smoke.ts`)

1. Pro org: mint upload URL → PUT small test image → PATCH player → `loadState` shows resolvable URL.
2. Community org: upload-url returns 402/403.
3. Avatar appears on `/state` and slideshow page.

### 16.2 Manual

- Upload PNG/JPEG/WebP; reject SVG/PDF.
- Two orgs cannot overwrite each other's paths.
- Public slideshow loads images from Supabase CDN (not data URLs).

## 17. Implementation checklist

- [ ] Create `assets` (+ `exports` later) buckets in Supabase dashboard
- [ ] Configure bucket policies (public read on `assets`, no open write)
- [ ] `src/lib/storage.ts`, `src/lib/assets.ts`
- [ ] Upload-url API routes with entitlement + path generation
- [ ] `ImageUploadField` component; wire forms + live setup
- [ ] `Avatar` + slideshow/print use `assetPublicUrl` / transform URLs
- [ ] Stop writing new data URLs on Pro+ (keep fallback on Community)
- [ ] Cleanup job on player/tournament/org delete
- [ ] Smoke tests

## 18. Acceptance criteria

- Pro+ player photos and org logos stored in Supabase Storage, not in Postgres text.
- Upload does not pass file bytes through Vercel.
- Community tier behavior unchanged (initials / optional small data URL).
- Public slideshow and print pages render storage URLs from CDN.
- Tenant paths enforced; service role never exposed to browser.
- Legacy data URLs still render.

## 19. Phase placement

**Phase 2** (with Supabase Realtime, doc 10) — Stickiness / PLG.

## 20. Decisions (locked)

- **Vendor:** Supabase Storage (same project as Postgres + Realtime).
- **Upload pattern:** server-minted signed upload URL → client PUT → DB stores path.
- **Not using:** S3/R2, Vercel blob, storing raster bytes in Postgres for new uploads.
- **Raster only:** jpeg/png/webp — no SVG.
