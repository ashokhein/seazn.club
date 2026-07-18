import "server-only";
import { createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";

// PROMPT-63 §3 — Ed25519 signing of the audit ledger's head hash. The private
// key lives ONLY in server env (fly secret AUDIT_SIGNING_KEY = base64 PKCS8
// DER), never the DB: a downloaded signed export pins a head_hash that a
// later-rewritten ledger cannot reproduce, closing the "DB owner rewrites the
// whole chain" hole for downloaded artifacts. Key rotation: point
// AUDIT_SIGNING_PREV_PUBKEY (+ _KEY_ID) at the retiring public key; both stay
// published at /.well-known/seazn-audit-keys. See
// docs/superpowers/runbooks/audit-signing.md.

export interface AuditSignature {
  alg: "ed25519";
  key_id: string;
  issued_at: string;
  signature: string; // base64 over `${fixtureId}|${headHash}|${issuedAt}` utf8
}

export function auditSignMessage(fixtureId: string, headHash: string, issuedAt: string): string {
  return `${fixtureId}|${headHash}|${issuedAt}`;
}

function privateKey() {
  const b64 = process.env.AUDIT_SIGNING_KEY;
  if (!b64) return null;
  try {
    return createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
  } catch {
    return null; // malformed secret — export ships unsigned rather than 500s
  }
}

/** Sign the ledger head. Returns null when no signing key is configured
 *  (dev / not-yet-provisioned envs): the export then carries signature: null. */
export function signAuditHead(
  fixtureId: string,
  headHash: string,
  issuedAt: string,
): AuditSignature | null {
  const key = privateKey();
  if (key === null) return null;
  const signature = edSign(null, Buffer.from(auditSignMessage(fixtureId, headHash, issuedAt), "utf8"), key);
  return {
    alg: "ed25519",
    key_id: process.env.AUDIT_SIGNING_KEY_ID ?? "k1",
    issued_at: issuedAt,
    signature: signature.toString("base64"),
  };
}

/** Public keys for independent verification — current (derived from the
 *  private key) plus the previous one during rotation. */
export function auditPublicKeys(): { key_id: string; public_key_pem: string }[] {
  const keys: { key_id: string; public_key_pem: string }[] = [];
  const key = privateKey();
  if (key !== null) {
    keys.push({
      key_id: process.env.AUDIT_SIGNING_KEY_ID ?? "k1",
      public_key_pem: createPublicKey(key).export({ format: "pem", type: "spki" }).toString(),
    });
  }
  const pem = (v: string) =>
    v.includes("BEGIN PUBLIC KEY") ? v : Buffer.from(v, "base64").toString("utf8");
  // F1: any number of retired keys — AUDIT_SIGNING_PREV_PUBKEYS is a JSON
  // array of { key_id, public_key_pem } (PEM or base64(PEM)). Retired PUBLIC
  // keys stay published forever so old downloads keep verifying by key_id.
  const list = process.env.AUDIT_SIGNING_PREV_PUBKEYS;
  if (list) {
    try {
      for (const k of JSON.parse(list) as { key_id: string; public_key_pem: string }[]) {
        if (k?.key_id && k?.public_key_pem) {
          keys.push({ key_id: k.key_id, public_key_pem: pem(k.public_key_pem) });
        }
      }
    } catch {
      // malformed env — publish what we can, never 500 the keys endpoint
    }
  }
  // Single-slot form kept for back-compat with the first rotation's runbook.
  const prev = process.env.AUDIT_SIGNING_PREV_PUBKEY;
  if (prev) {
    keys.push({
      key_id: process.env.AUDIT_SIGNING_PREV_KEY_ID ?? "k0",
      public_key_pem: pem(prev),
    });
  }
  return keys;
}
