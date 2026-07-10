# PROMPT-00 — Conventions Preamble

> Not a task. Paste (or reference) this block at the top of every other PROMPT session.

---

You are implementing Engine v2 for seazn.club per the design corpus in `engine/`. Before
writing code:

1. Read `engine/README.md` plus the design docs the prompt lists under **Read first**.
2. This repo's Next.js has breaking changes — read the relevant guide in
   `node_modules/next/dist/docs/` before touching `apps/web` (per AGENTS.md).
3. Existing conventions to preserve:
   - Types first: Zod schema + inferred type before behaviour.
   - Server-only modules import `"server-only"`; engine package imports **nothing**
     effectful (no postgres/next/ioredis/Date.now/Math.random).
   - API handlers wrap in `handler()` (`src/lib/http.ts` pattern); errors are typed
     (`EngineError` codes → HTTP mapping, `PaymentRequiredError` → 402).
   - DB writes inside `withTenant(orgId, tx => …)`; RLS + denormalized `org_id`
     (migration 010 pattern); append-only ledgers get the 011 hash-chain pattern.
   - Tests: vitest; property tests with fast-check; every engine rule comments its spec
     section (`// spec 04 §2.4`).
4. Definition of done for every prompt: code + tests + `npm test` green +
   `npm run lint` green + a short summary of deviations from the design doc (if any,
   update the doc in the same PR — docs and code may not drift).
5. Do not touch prompts/docs scope beyond your prompt. Do not delete the v1 engine until
   PROMPT-15 says so.
