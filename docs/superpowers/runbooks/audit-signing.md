# Audit-export signing (PROMPT-63)

The per-match audit export (`GET /api/v1/fixtures/{id}/audit`) signs the
ledger's `head_hash` with an **Ed25519** key from server env. Verification
keys are public at `GET /.well-known/seazn-audit-keys`. Without the secret the
export still works but ships `"signature": null` — provision the key on stg
and prod **before** announcing the feature.

## Generate a keypair

```bash
node -e '
const { generateKeyPairSync, createPublicKey } = require("node:crypto");
const { privateKey } = generateKeyPairSync("ed25519");
console.log("AUDIT_SIGNING_KEY=" + privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
console.log(createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString());
'
```

## Provision (per app)

```bash
fly secrets set -a seazn-club-stg AUDIT_SIGNING_KEY=<base64> AUDIT_SIGNING_KEY_ID=k1
fly secrets set -a seazn-club     AUDIT_SIGNING_KEY=<base64> AUDIT_SIGNING_KEY_ID=k1
```

Use **different keys per environment**. Never store the private key anywhere
but the fly secret (not the DB, not the repo).

## Rotation

1. Generate a new pair; note the OLD public key PEM.
2. `fly secrets set AUDIT_SIGNING_KEY=<new> AUDIT_SIGNING_KEY_ID=k2 \
    AUDIT_SIGNING_PREV_PUBKEY=<base64 of the old PEM> AUDIT_SIGNING_PREV_KEY_ID=k1`
3. Both keys stay published at `/.well-known/seazn-audit-keys`; old downloads
   keep verifying via `key_id`. Drop the PREV vars after a deprecation window.

## Independent verification (what the help article links)

```js
// verify-audit.mjs <audit.json> — no dependencies
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
const audit = JSON.parse(readFileSync(process.argv[2], "utf8")).data ?? JSON.parse(readFileSync(process.argv[2], "utf8"));
const keys = (await (await fetch("https://seazn.club/.well-known/seazn-audit-keys")).json()).keys;
const key = keys.find((k) => k.key_id === audit.signature.key_id);
const msg = `${audit.fixture.id}|${audit.head_hash}|${audit.signature.issued_at}`;
const ok = verify(null, Buffer.from(msg, "utf8"), createPublicKey(key.public_key_pem),
  Buffer.from(audit.signature.signature, "base64"));
console.log(ok ? "signature VALID" : "signature INVALID");
```

Chain re-walk (optional, stronger): recompute
`sha256(coalesce(prev,'')||'|'||concat_ws('|', id, fixture_id, seq, type, payload_text, voids_event_id, recorded_by, recorded_at))`
per event — `payload_text` must be the exact stored Postgres jsonb
serialisation (the export carries it verbatim), which is why the signature is
the primary cross-system proof.
