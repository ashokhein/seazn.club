# S10 — #419 (W8): pad chassis + universal renderer (flag off)

Paste this whole file as the session opener. Read `_RULES.md`, then `_INDEX.md`
(S6's PadSpec shape and label-key convention), then this. Large web session.

Branch `feat/s10-w8-chassis-renderer` in a fresh worktree. One PR. Issue #419.
Design: `../2026-08-03-scoringpad-v2-design.md` (Part II, "Chassis" + "Universal renderer").

The greenfield pad: a new `apps/web/src/components/v2/scorepad/` tree. Headless
chassis (pipeline, offline queue, timeline, attribution) plus the universal
renderer that executes any `PadSpec`. **v1 pads untouched; no dispatcher changes;
flag stays off this session.**

## Why

v1's chassis is three in-memory retries and a resync (`device-score-pad.tsx`,
re-pin) — tab death courtside loses the queue. And v1 has no renderer concept at
all: every sport's UI is hand-written, so the W4/S6 enrichment would otherwise
wait on eight rewrites. One renderer makes every sport scoreable the day its
module lands.

## Scope

1. **Pipeline (headless hook layer)**: append
   `{expected_seq, type, payload, idempotency_key}` →
   `POST /api/v1/fixtures/[id]/events`; on 409 `SEQ_CONFLICT` → `since_seq`
   resync; optimistic local fold using the module's own fold (the engine is pure,
   so it runs in the browser); reconcile optimistic state against server
   `match_states` on every ack.
2. **Offline queue**: pending events in IndexedDB keyed by `idempotency_key`,
   surviving tab death and reload, replayed in order **renegotiating
   `expected_seq`**; visible queue depth and an explicit "offline — keep scoring"
   state. The hash chain stays server-side; the client preserves only order and
   idempotency.
3. **Timeline**: full event list with fold-derived captions, `core.void` undo,
   void + re-append correction flow, per-event attribution display,
   `recorded_by` / `device_link_id` provenance.
4. **Attribution picker**: lineup-aware person chips (squad number, position,
   captain) honouring PadSpec requirements (`none|side|person(role?)|persons(n)`);
   side-only fallback when no roster exists — **never blocks the action**.
   S3 put positions into `State`, so the keeper is nameable — the picker should
   use it rather than a kickoff snapshot.
5. **Contexts**: works under both auth modes — the authed console and the
   device-link token (`/score/[token]`) — and both transports: Supabase realtime
   channel `fixture:{id}` where entitled, 15s polling fallback otherwise (load
   the `supabase:supabase` skill before the realtime hook).
6. **Variant resolution**: the server passes the resolved `cfg`
   (base ⊕ variant preset ⊕ org overrides from `sport_variants`) and the
   division's **pinned** `module_version`; the pad renders the **pinned** module's
   `padSpec(cfg)`, never `latest`.
7. **Universal renderer**: walks the PadSpec — phase navigation (pre/live/post),
   panels as button grids/forms sized for courtside use, action parameter entry
   with cfg-derived bounds, gate predicates over folded state, fidelity switcher
   (tier per fixture; mid-match upgrade allowed, downgrade warns), i18n via
   dictionary keys with the engine `labelKey` fallback. **375px-first.**

No dispatcher or route changes; v1 pads and both entry points behave exactly as
today. New strings in all 4 dictionaries.

## Acceptance criteria

- [ ] Kill the tab mid-queue, reopen: queued events replay **in order**, none
      duplicated (idempotency proven), and the scorer sees queue depth throughout
- [ ] Airplane-mode scoring continues; on reconnect the queue drains; a 409
      mid-drain resyncs and completes
- [ ] Optimistic fold **equals** server fold for generated streams across all
      families (property test)
- [ ] The renderer reaches **every action of every module × variant** — drive it
      from S6's conformance fixtures, full tier, both auth contexts
- [ ] Tier switch mid-match: upgrade keeps state; downgrade warns and hides,
      never deletes
- [ ] Pinned module version is honoured — a division pinned to an older version
      renders that version's spec, not `latest` (regression test)
- [ ] Attribution picker reads the keeper from `State`, honours every requirement
      shape, and never blocks an action when no roster exists
- [ ] i18n ×4 green; `i18n:gen-keys` + `openapi:gen` if anything moved, then
      `git status --porcelain` empty
- [ ] Screenshots (cricket + a generic sport) at desktop **and 375px**, no
      horizontal page scroll, touch-sized targets
- [ ] `git diff --stat`: nothing outside `scorepad/` + dictionaries
- [ ] Vitest counts from the JSON reporter; `tsc EXIT=0`; lint `✖ 0 problems`

### Test types

- **Unit** — queue ordering, idempotency, 409 recovery, expected_seq
  renegotiation, predicate evaluation.
- **Component** — renderer per phase/tier over 2+ contrasting sports (cricket and
  boardgame); picker requirement matrix.
- **E2E (Playwright)** — the tree is not wired to a route this session, so full
  end-to-end lands in **S12**. What this session **must** still do: mount the pad
  behind a test-only harness route (or Playwright component test) and drive tab
  death + offline + drain in a **real browser** — a fake-IndexedDB unit test is
  not evidence that the queue survives a real reload. State clearly in the PR
  body which parts are browser-verified and which wait for S12.
- **Smoke — deferred to S13** (flag is off; no smoke path reaches v2).
- **Regression** — optimistic/server fold divergence; duplicate on replay;
  pinned-version resolution.

## Gotchas

- The engine import into the browser bundle must stay **pure** — no server-only
  imports leak through the fold path. Verify the bundle does not pull `engine-db`.
- **`expected_seq` renegotiation after resync is the correctness heart**: replay
  must re-read the server seq, never trust the queue's stale value.
- Realtime is entitlement-gated with a device-link bypass — the hook must degrade
  to polling with no user-visible error on Community plans.
- A WASM/native dep needs **both** tracing includes and `serverExternalPackages`;
  a silent prod no-op can pass every gate and only fail against a real standalone
  server. If the pad pulls any such dep, verify against a standalone build.
- `output: standalone` means `next start` serves 200 from the **wrong** server —
  check assets, not just the page. Follow `seazn-local-env`.
- Never `rm -rf .next` under a live dev server; `/magic-link` never hydrates on a
  dev server, so UI login there is impossible — use the prod-build recipe.
- 375px is the **primary** surface (a phone, courtside). Desktop is the adaptation.

## Execution

Chassis (1–6) then renderer (7). One new tree, tightly interlocked → **one
sequential implementer → reviewer loop**, no parallel agents.

**Scout (sonnet) brief:** (a) the existing v1 chassis — append path, retry,
resync, and the events route contract (`expected_seq`, 409 shape,
`idempotency_key`); (b) both entry points' current prop shapes
(`fixture-console.tsx`, `device-score-pad.tsx`); (c) the repo's feature-flag
convention; (d) any existing fold-in-browser precedent; (e) the realtime token
route shape. file:line table only, under 30 lines, no file contents.

**Implementer (opus, high):** brief carries the scout table, S6's PadSpec type
shape (paste it — do not make the agent re-read the engine), the pinned-version
rule, and the 375px-first requirement. Load `frontend-design:frontend-design`
before renderer work and `supabase:supabase` before the realtime hook.

**Reviewer (sonnet):** does replay re-read server seq or reuse a stale one? Can a
duplicate slip through on double-fire? Does the renderer hardcode anything a
`PadSpec` should supply? Does the bundle pull server-only code? Gap list only.

## On close

`_INDEX.md`: S10 → DONE, the chassis contract S11's skins consume, the flag name
chosen, and exactly which e2e assertions were pushed to S12. Memory + snapshot.
