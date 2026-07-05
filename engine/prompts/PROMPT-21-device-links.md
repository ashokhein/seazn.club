# PROMPT-21 — Day-of Device Links (Account-less Courtside Scoring)

**Read first:** `engine/13-roles-and-scorer.md` §7 (normative); doc 08 §4 (scoring
endpoint, idempotency), doc 08 §6 (rate limits), doc 10 §2 (entitlement placement).
Preamble: PROMPT-00. Depends: PROMPT-18 (scorer role — device links are strictly-less
capable), PROMPT-17 (schedule_settings.tz for end-of-day expiry).

## Task

1. **Schema**: `device_links` per doc 13 §7 (RLS + org_id house pattern);
   `score_events.device_link_id uuid null` (rides OUTSIDE the hash-chain canonical —
   existing chains must stay valid; add a migration test proving an old chain still
   verifies).
2. **Mint/revoke API**: `POST /api/v1/fixtures/{id}/device-links` (editor only; secret
   returned once, sha256 stored — reuse the api_keys pattern) and
   `DELETE .../device-links/{linkId}`. Minting revokes prior active links for the
   fixture (one live device per fixture). Expiry = end-of-day in the fixture's venue tz
   (`schedule_settings.tz`, else UTC). Entitlement gate `scoring.device_links`
   (seed: community ✗ / pro ✓ / business ✓ + feature-copy line).
3. **Token auth path**: `Authorization: Bearer dl_…` (new prefix) accepted ONLY by the
   fixture-scoped scoring surface: append events, void events created via the same
   link pre-finalize, read fixture state/events, realtime token. Attribution:
   `recorded_by = issued_by`, `device_link_id` set. Everything else — finalize,
   lineups, any other resource — 403. Expired/revoked → 401 with a distinct code the
   pad can render ("link expired").
4. **Pad**: `/score/{token}` page — no session, stripped scoring pad (reuse the sport
   pads), fixture summary, undo-own, offline-tolerant retry via the existing
   idempotency_key mechanics. Token lives in the tab only. Organiser side: "Hand this
   device over" on the fixture console → QR + link + revoke button (sport-aware copy).
5. **Rate limiting**: per-link limiter at the scoring cadence (doc 08 §6) + per-IP on
   the mint route.
6. Update doc 13 §7 if implementation deviates; doc 08 §2 auth-modes table gains the
   device-link row.

## Acceptance

- E2E: organiser mints a link for one fixture (QR payload = `/score/{token}`), holder
  scores winner/draw + voids own mistake without any session; events carry
  `recorded_by = issuer` and `device_link_id`; finalize via link → 403; other fixture
  via link → 403/404; after `expires_at` (clock injected) → 401 "expired"; revoke →
  immediate 401; re-mint revokes the old link.
- Hash-chain: verify_score_events_chain stays clean across device-link events; a
  pre-migration chain still verifies (canonical unchanged).
- Community org: mint → 402 `scoring.device_links`; account-scorer flow (PROMPT-18)
  unaffected.
- `check:rls` covers `device_links`.
