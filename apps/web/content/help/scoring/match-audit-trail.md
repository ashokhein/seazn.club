---
title: The match audit trail
description: Every match keeps a tamper-evident scoring ledger — Pro organisers can download it, cryptographically signed.
order: 9
---

Every score entry is an append-only event in a per-match ledger — corrections are new (void) events, never edits — and each event is **hash-chained** to the one before it. The fixture console shows the chain's verdict: *Ledger verified ✓*, or exactly where it breaks if anyone has tampered with the database directly.

**Download (Pro).** *Download audit* on the fixture console fetches the full trail — every event with its chain hashes — as JSON, or a readable PDF with `?format=pdf`. The download is **signed** (Ed25519) over the ledger's head hash, so a file you saved yesterday proves what the ledger said yesterday, even against someone who can rewrite the database later.

**Verify independently.** Public keys live at `/.well-known/seazn-audit-keys`. Check a download with ~10 lines of Node:

```js
import { createPublicKey, verify } from "node:crypto";
const audit = /* the downloaded JSON's data */;
const keys = (await (await fetch("https://seazn.club/.well-known/seazn-audit-keys")).json()).keys;
const key = keys.find(k => k.key_id === audit.signature.key_id);
const msg = `${audit.fixture.id}|${audit.head_hash}|${audit.signature.issued_at}`;
verify(null, Buffer.from(msg), createPublicKey(key.public_key_pem),
       Buffer.from(audit.signature.signature, "base64")); // → true
```
