# PROMPT-15 — App Integration, Migration & v1 Cutover

**Read first:** `engine/07-greenfield-schema.md` note 5 (migration map); `engine/08-api-design.md`
§1; all landed code. Preamble: PROMPT-00. Depends: PROMPT-11, 12, 13. **Destructive step —
run last, behind a staging rehearsal.**

## Task
1. **Organiser UI on v2**: rebuild the authed flows on the new domain — competition
   wizard (description, visibility, branding), division builder (sport → variant →
   eligibility template → stage graph), entrant/roster management (persons picker, CSV
   import, position/role assignment from the module catalog), fixture console (schedule,
   lineups, scoring UI per fidelity tier, void/undo, finalize), standings view with
   cascade trace. Sport-shaped scoring UIs: cricket ball pad, set-based rally pad,
   football timeline, boardgame result buttons — all driven by module event schemas
   (render forms from the Zod discriminated unions where feasible).
2. **Data migration** `scripts/migrate-v1-to-v2.ts` per doc 07 note 5:
   tournament → competition+division (sport `generic`, or a real module when the old
   `sport` key maps cleanly), players → persons+entrants, decided matches → synthetic
   `generic.result` events (hash-chained), seasons → competitions, org_sport_presets →
   org sport_variants. Idempotent, dry-run mode, per-org batching, verification report
   (counts + refolded outcomes == stored winners).
3. **Cutover**: feature flag `ENGINE_V2` per org → staged rollout; when all orgs
   migrated: delete v1 routes/`src/lib/{engine,tournament,pairing,standings,format}.ts`
   + old tables (archive `audit_log` → `audit_log_v1`), drop old `/api` BFF routes,
   redirect `/t/{slug}` public URLs to new dashboard paths (301 map table).
4. Update `development/README.md` status table + `DEFERRED.md`; move `engine/` docs to
   "implemented" status notes.
5. Staging rehearsal: run migration on a prod snapshot in staging; smoke suite + manual
   checklist (one real historical tournament verified round-trip) before prod.

## Acceptance
- Every v1 tournament visible and correct in v2 UI post-migration (verification report 0
  mismatches).
- v1 code deleted; bundle/dep graph free of old engine; CI green; smoke green in staging
  and prod.
- Public URLs preserved via redirects.
