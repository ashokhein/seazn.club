// PROMPT-63 §3 — Ed25519 head-hash signing: roundtrip verifies with the
// published public key; any byte flip invalidates; unset env ⇒ unsigned.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, verify as edVerify, createPublicKey } from "node:crypto";
import { auditPublicKeys, auditSignMessage, signAuditHead } from "../audit-sign";

const { privateKey } = generateKeyPairSync("ed25519");
const PRIV_B64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");

describe("audit signing", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("signs the head hash and the published key verifies it", () => {
    vi.stubEnv("AUDIT_SIGNING_KEY", PRIV_B64);
    vi.stubEnv("AUDIT_SIGNING_KEY_ID", "k7");
    const sig = signAuditHead("fx-1", "abc123", "2026-07-18T12:00:00Z");
    expect(sig).toMatchObject({ alg: "ed25519", key_id: "k7" });
    const [pub] = auditPublicKeys();
    expect(pub!.key_id).toBe("k7");
    const ok = edVerify(
      null,
      Buffer.from(auditSignMessage("fx-1", "abc123", "2026-07-18T12:00:00Z"), "utf8"),
      createPublicKey(pub!.public_key_pem),
      Buffer.from(sig!.signature, "base64"),
    );
    expect(ok).toBe(true);
  });

  it("a flipped head-hash byte fails verification", () => {
    vi.stubEnv("AUDIT_SIGNING_KEY", PRIV_B64);
    const sig = signAuditHead("fx-1", "abc123", "2026-07-18T12:00:00Z");
    const [pub] = auditPublicKeys();
    const ok = edVerify(
      null,
      Buffer.from(auditSignMessage("fx-1", "abc124", "2026-07-18T12:00:00Z"), "utf8"),
      createPublicKey(pub!.public_key_pem),
      Buffer.from(sig!.signature, "base64"),
    );
    expect(ok).toBe(false);
  });

  it("returns null (unsigned) without a configured key; malformed key never throws", () => {
    expect(signAuditHead("fx", "h", "t")).toBeNull();
    expect(auditPublicKeys()).toEqual([]);
    vi.stubEnv("AUDIT_SIGNING_KEY", "not-a-key");
    expect(signAuditHead("fx", "h", "t")).toBeNull();
  });

  it("publishes the previous public key during rotation", () => {
    vi.stubEnv("AUDIT_SIGNING_KEY", PRIV_B64);
    const pem = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
    vi.stubEnv("AUDIT_SIGNING_PREV_PUBKEY", Buffer.from(pem, "utf8").toString("base64"));
    vi.stubEnv("AUDIT_SIGNING_PREV_KEY_ID", "k6");
    const keys = auditPublicKeys();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatchObject({ key_id: "k6" });
    expect(keys[1]!.public_key_pem).toContain("BEGIN PUBLIC KEY");
  });
});

describe("multi-key rotation (F1)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("publishes every retired key from AUDIT_SIGNING_PREV_PUBKEYS plus the current", () => {
    vi.stubEnv("AUDIT_SIGNING_KEY", PRIV_B64);
    vi.stubEnv("AUDIT_SIGNING_KEY_ID", "k3");
    const pemOf = createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString();
    vi.stubEnv(
      "AUDIT_SIGNING_PREV_PUBKEYS",
      JSON.stringify([
        { key_id: "k2", public_key_pem: pemOf },
        { key_id: "k1", public_key_pem: Buffer.from(pemOf).toString("base64") },
      ]),
    );
    const keys = auditPublicKeys();
    expect(keys.map((k) => k.key_id)).toEqual(["k3", "k2", "k1"]);
    expect(keys.every((k) => k.public_key_pem.includes("BEGIN PUBLIC KEY"))).toBe(true);
  });

  it("malformed JSON never breaks the endpoint", () => {
    vi.stubEnv("AUDIT_SIGNING_KEY", PRIV_B64);
    vi.stubEnv("AUDIT_SIGNING_PREV_PUBKEYS", "{nope");
    expect(auditPublicKeys().map((k) => k.key_id)).toEqual(["k1"]);
  });
});
