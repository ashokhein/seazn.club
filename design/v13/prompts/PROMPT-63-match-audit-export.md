# PROMPT-63 — Signed per-match audit export (Pro)

**Sport-agnostic.** The scoring ledger (`score_events`) is shared by every sport;
the export dumps the raw event stream + hash chain and never interprets
sport-specific payloads. Works for football, cricket, tennis, any module.

**Read first:**
- `db/migration/v2-engine/functions/V226__hash_chain_functions.sql` — the hash
  chain **already exists**. `v2_row_hash(prev, canonical) = sha256(coalesce(prev,'')
  || '|' || canonical)` hex; `score_events_hash_chain()` (BEFORE INSERT trigger
  `trg_zhash`) sets `prev_hash`/`row_hash` with canonical
  `concat_ws('|', id, fixture_id, seq, type, payload::text,
  coalesce(voids_event_id,''), coalesce(recorded_by,''), recorded_at)`;
  **`verify_score_events_chain(p_fixture uuid) returns uuid`** returns the id of
  the first tampered row (NULL = intact). This prompt **builds on** it — no
  changes to the chain itself.
- `apps/web/src/server/engine-db/append-event.ts` — how events are appended
  under the per-fixture advisory lock (the chain's serialisation guarantee).
- `apps/web/src/server/usecases/fixtures.ts` — `listEvents` / `EventOut` (the
  ledger read; **extend to include `prev_hash`/`row_hash`** for the export, or
  add a dedicated `readAuditLedger`).
- `apps/web/src/app/api/v1/fixtures/[id]/events/route.ts` — the existing
  append/resync route; the audit export is a sibling read route.
- `apps/web/src/app/admin/audit/page.tsx` — precedent: it already calls
  `verify_staff_audit_log_chain()` and shows chain-broken status. Mirror that
  surfacing for `verify_score_events_chain` on the match/console.
- Entitlements: `apps/web/src/lib/entitlements.ts` + `apps/web/src/lib/
  feature-copy.ts` + the `plan_entitlements` catalog (migration) — add the new
  Pro feature key.
- PDF (soft-dep **v12 PROMPT-58**): `packages/engine/src/exports/{types,build}.ts`
  + `apps/web/src/server/doc-render.ts` + `exports/[kind]` route — for the human
  PDF variant.

**Depends:** hash chain (V226) — already shipped. Human-PDF variant soft-depends
on **v12 PROMPT-58** (branded renderer + `DocKind`); the **JSON** variant is
independent and lands first. **Migration:** one `plan_entitlements` row for the
new feature key; optionally a column for a published signing-key id (see §3).

## Context

The product already keeps a tamper-**evident** scoring ledger: `score_events` is
append-only (voids are new rows, never edits/deletes) and hash-chained per
fixture, with a DB verifier. What's missing is (a) a way for a Pro organiser to
**download the per-match activity trail**, (b) making that download
independently **tamper-proof** (the internal chain alone can be rewritten by
whoever controls the DB), and (c) surfacing chain status for scoring the way
`/admin/audit` already does for the staff log.

## Task

### 1. Audit ledger read (JSON, Pro-gated)

New `GET /api/v1/fixtures/{id}/audit` → the full per-fixture ledger:

```jsonc
{
  "fixture": { "id", "division_id", "org_id", "no", "entrants": {…} },
  "canonical_spec": "sha256(coalesce(prev,'')||'|'||concat_ws('|', id, fixture_id, seq, type, payload_text, voids_event_id, recorded_by, recorded_at))",
  "events": [ { "seq", "type", "payload", "recorded_by", "recorded_at",
               "voids_event_id", "prev_hash", "row_hash" } … ],   // full stream, seq order
  "head_hash": "<row_hash of the last event>",
  "verified": true,                     // verify_score_events_chain(id) IS NULL
  "first_tampered_seq": null,           // else the offending seq
  "signature": { … see §3 }
}
```

- Extend `listEvents`/`EventOut` (or a dedicated `readAuditLedger`) to include
  `prev_hash`/`row_hash`; return the **whole** stream (not `since_seq`).
- Compute `verified` by calling `verify_score_events_chain(id)` in the same read.
- **Canonical reproducibility caveat:** the chain hashes `payload::text` as
  Postgres serialises jsonb. Document that independent chain re-computation must
  use the exact stored text; the signature (§3) is the primary cross-system proof
  so verifiers needn't reproduce pg's jsonb formatting.

### 2. Human PDF variant (soft-dep v12)

Add `audit` (or `match_report_audit`) as a `DocKind`; `buildAuditLedger(...)` →
`DocModel` with a readable timeline (time, actor, event, score-after) plus a
verification stamp (verified ✓ / TAMPERED at seq N), the `head_hash`, and the
signature block. Rendered landscape/portrait via `doc-render.ts` with v12 branded
chrome. `exports/[kind]` accepts `audit`, `format=pdf|json`.

### 3. Signed exports (independent tamper-proofing)

- On export, the server **signs the `head_hash`** (+ fixtureId + issuedAt) with an
  **Ed25519** private key from server env (`AUDIT_SIGNING_KEY`, never in the DB).
  Include `{ alg: "ed25519", key_id, issued_at, signature }` in the JSON and on
  the PDF.
- Publish the **public key** at a stable, unauthenticated endpoint
  (e.g. `GET /.well-known/seazn-audit-keys` or `/api/v1/audit/keys`) so anyone can
  verify a downloaded file without trusting the running app. Support `key_id`
  rotation (publish current + previous).
- This closes the "DB owner silently rewrites the whole chain" hole for
  **downloaded artifacts**: an old signed export pins a `head_hash` that a
  rewritten ledger can't reproduce.
- Ship a tiny documented verify recipe (Node one-file / openssl) in
  `content/help` so a third party can check signature + (optionally) re-walk the
  chain.

### 4. Gating + surfacing

- New Pro entitlement **`scoring.audit_export`**: a `plan_entitlements` row
  (pro = true, community = false), an `entitlements.ts` key, and `feature-copy.ts`
  user-facing copy. The export route requires it (402 with the feature key when
  absent — same pattern as `orgs.max_owned`).
- On the fixture/console, surface **"ledger verified ✓"** (from
  `verify_score_events_chain`) and a **Download audit** button (Pro), mirroring
  `/admin/audit`'s staff-log treatment.

## Tests (regression — each fails without its change)

- `GET /fixtures/{id}/audit` returns the full stream with `prev_hash`/`row_hash`,
  `verified: true`, and a valid Ed25519 signature over `head_hash` (verify with
  the published public key). Non-Pro org → 402 `scoring.audit_export`.
- Tamper test: mutate a row's payload directly in the DB (bypassing append) →
  `verify_score_events_chain` returns that row and the export reports
  `verified: false` / `first_tampered_seq`.
- Signature test: flipping any byte of `head_hash` invalidates the signature.
- PDF route test: `exports/audit?format=pdf` returns a PDF for a scored fixture.

## Non-goals

- No change to the hash chain / trigger (V226 stays as-is).
- No blockchain / external anchoring service (signed head-hash is the scope; a
  periodic public anchor can be a later prompt).
- No per-event signing (sign the head hash, not each row).
- Voids remain the only "edit" mechanism; the export shows them as void rows.

## Help / docs pass (mandatory)

`content/help/*`: what the match audit trail is, that it's tamper-evident +
signed, how to download it (Pro), and the independent verify recipe. Same PR.
