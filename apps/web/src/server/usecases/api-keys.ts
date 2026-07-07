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
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

const COLS = ["id", "name", "scopes", "last_used_at", "revoked_at", "created_at"] as const;

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
  // Doc 10 §1 Pro→Business ladder: write scopes need `api.write` — Business only.
  if (input.scopes.includes("write")) await requireFeature(auth.orgId, "api.write");
  const secret = mintApiKeySecret();
  const row = await withTenant(auth.orgId, async (tx) => {
    const [created] = await tx<ApiKeyRow[]>`
      insert into api_keys (org_id, name, key_hash, scopes, created_by)
      values (${auth.orgId}, ${input.name}, ${hashApiKey(secret)},
              ${tx.json(input.scopes as never)}, ${auth.userId})
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
