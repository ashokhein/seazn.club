# v5/01 — Translation pipeline (en → fr/es/hi/ta/nl)

Normative for PROMPT-44..47. **en dictionaries are the single source of truth**; the other
five locales are generated artifacts that humans review — never hand-edit en and a target
in the same PR without regenerating.

## §1 en.json authoring conventions

- Keys `surface.area.slug`, full sentences per key (no string concatenation across keys).
- Variables `{name}`, `{count}` — ICU-lite; plurals as sibling keys `x.one` / `x.other`
  (target locales may add forms the script requests per `Intl.PluralRules` categories —
  none of the six needs beyond one/other except future-proofing).
- No markup in values except `<b>`/`<i>` pass-through where the component renders rich
  text via a tiny `<T>` helper; links stay in JSX, split copy around them.
- Protected terms never translated: `seazn.club`, plan names (`Pro`, `Community`,
  `Event Pass`), sport format names where they are proper nouns (`Americano`,
  `Mexicano`, `Swiss`), `API`.

## §2 Machine translation — `scripts/translate-dictionaries.ts`

Anthropic **Batches API** (50% token price; latency irrelevant offline):

- Chunk en namespace files into ≤200-key JSON objects; one batch request per
  (chunk × target locale), `custom_id = {locale}:{namespace}:{chunk}`.
- Model `claude-opus-4-8`. System prompt per locale: translator persona for sports-league
  software; glossary table (protected terms + preferred sport vocabulary per locale, e.g.
  fixture→fr «rencontre», standings→es «clasificación», court→ta «மைதானம்» vs
  transliteration choices — glossary file `scripts/i18n-glossary.json` is reviewable);
  rules: preserve `{placeholders}` exactly, preserve `<b>`/`<i>`, match register
  (UI = concise informal-polite; emails = warmer), length discipline for button keys
  (flagged `#btn` comment in en source → "≤24 chars where possible").
- Structured output: same-shaped JSON object (strict schema built from the chunk's keys)
  → drop-in namespace files.
- Idempotent + incremental: script hashes each en value into
  `dictionaries/.hashes.json`; only changed/new keys are re-sent (cost control, stable
  reviewed translations don't churn).

## §3 Review workflow

Generated locales land as a PR with per-locale diff; review checklist in the PR template:
placeholders intact (CI-checked), spot-check 20 random keys per locale, native-speaker
pass for hi/ta before first release (fr/es/nl acceptable at MT-quality launch, flagged).
`// REVIEWED` markers not used — review state lives in git history; regenerations only
touch keys whose en source changed (§2 hashing).

## §4 CI guards (vitest, PROMPT-44)

1. **Key parity**: every locale has exactly en's key set per namespace (missing/extra →
   fail with key list).
2. **Placeholder parity**: `{vars}` set per key identical across locales.
3. **Drift**: en value hash ≠ `.hashes.json` entry while target unchanged → fail
   ("stale translation — run translate script").
4. **No hardcoded-string regression** (ratchet): lint rule / test greps the extracted
   surfaces (per-prompt allowlist shrinks as 45/46 land) for JSX literal text outside
   `t()` — new violations fail; existing files burn down via allowlist file.

## §5 Pseudo-locale QA

Dev-only locale `en-XA` (accented-expanded pseudotranslation generated locally, not
committed): lengthens strings ~35% and brackets them — layout-overflow QA for 45/46
e2e runs at 390px. Enabled via `SEAZN_PSEUDO_LOCALE=1` in dev/proxy only.

## §6 Help docs (PROMPT-47 scope)

31 en markdown docs stay canonical. Translate the top 8 by help-page traffic per locale
into `content/help/{locale}/{slug}.md` via the same batch script (markdown-aware prompt:
preserve headings/anchors/frontmatter, don't translate code/paths). Untranslated docs
render en body + dictionary-driven "This article is in English" notice. Help search stays
en-index + per-locale title index.
