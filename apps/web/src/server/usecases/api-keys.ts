import "server-only";
// API-key management (doc 08 §2, PROMPT-11 §4). Keys are org settings: session
// editors only (never key-authenticated — a key must not mint keys). The
// secret is returned exactly once; only its sha256 lands in the DB.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { requireFeature } from "@/lib/entitlements";
import { hashApiKey, mintApiKeySecret, type AuthCtx } from "@/server/api-v1/auth";
import type { CreateApiKey } from "@/server/api-v1/schemas";

export interface ApiKeyRow {
  id: string;
  name: string;
  scopes: string[];
  competition_id: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const COLS = [
  "id", "name", "scopes", "competition_id", "last_used_at", "revoked_at", "created_at",
] as const;

function requireSession(auth: AuthCtx): void {
  if (auth.via !== "session") {
    throw new HttpError(403, "API keys can only be managed with a session login");
  }
}

export async function listApiKeys(auth: AuthCtx): Promise<ApiKeyRow[]> {
  requireSession(auth);
  return withTenant(auth.orgId, (tx) => tx<ApiKeyRow[]>`
    select ${tx(COLS)} from api_keys order by created_at desc, id`);
}

export async function createApiKey(
  auth: AuthCtx,
  input: CreateApiKey,
): Promise<ApiKeyRow & { secret: string }> {
  requireSession(auth);
  await requireFeature(auth.orgId, "api.access"); // 402 for non-Pro orgs
  // v3/08 §2: scopes are read | score | manage (legacy "write" ⇒ manage).
  const scopes = [...new Set(input.scopes.map((s) => (s === "write" ? "manage" : s)))];
  // V290 re-arms the above-Pro rung: score/manage scopes need api.write
  // (Pro Plus). Read-only keys stay at api.access (Pro).
  if (scopes.some((s) => s !== "read")) await requireFeature(auth.orgId, "api.write");
  const pin = input.competition_id ?? null;
  const secret = mintApiKeySecret();
  const row = await withTenant(auth.orgId, async (tx) => {
    if (pin) {
      // The pin must be the org's own competition — a foreign id would mint
      // a key that can never authenticate anyway, but fail loudly now.
      const [comp] = await tx<{ id: string }[]>`
        select id from competitions where id = ${pin}`;
      if (!comp) throw new HttpError(404, "Competition not found");
    }
    const [created] = await tx<ApiKeyRow[]>`
      insert into api_keys (org_id, name, key_hash, scopes, competition_id, created_by)
      values (${auth.orgId}, ${input.name}, ${hashApiKey(secret)},
              ${tx.json(scopes as never)}, ${pin}, ${auth.userId})
      returning ${tx(COLS)}`;
    return created;
  });
  return { ...row, secret };
}

export async function revokeApiKey(auth: AuthCtx, keyId: string): Promise<ApiKeyRow> {
  requireSession(auth);
  return withTenant(auth.orgId, async (tx) => {
    const [row] = await tx<ApiKeyRow[]>`
      update api_keys set revoked_at = coalesce(revoked_at, now())
      where id = ${keyId} returning ${tx(COLS)}`;
    if (!row) throw new HttpError(404, "API key not found");
    return row;
  });
}
