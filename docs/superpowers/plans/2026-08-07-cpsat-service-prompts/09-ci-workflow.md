# Prompt 09: CI workflow

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "CI" — mirrors this repo's existing PR-only, path-sensitive CI
culture (smoke CI is PR-only already). Statelessness (no DB, no Flyway
ceremony) is what makes running this in CI at all affordable — a real
advantage over most of this repo's CI, which gates expensive suites to
PR-only specifically because standing up a DB is not cheap.

**Acceptance criteria**: this workflow runs on PRs touching
`services/cp-sat/**` or `proto/**`, and **never** on a PR that touches
neither — that's the entire point, not an incidental detail.

**Do not touch**: any existing workflow file. This is additive only —
per AGENTS.md's standing rule, never enable `.github/workflows/e2e.yml`,
and this prompt has nothing to do with that file regardless.

**Files:**
- Create: `.github/workflows/cp-sat-service.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: cp-sat-service

on:
  pull_request:
    paths:
      - "services/cp-sat/**"
      - "proto/**"

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: cd services/cp-sat && pip install -e ".[dev]"
      - run: cd services/cp-sat && python3 -m pytest tests/ bench/ -v
```

- [ ] **Step 2: Verify the path filter is correct**

After pushing, confirm via `gh workflow view cp-sat-service.yml` — or by
re-reading the `paths:` block above against a hypothetical PR that only
touches `apps/web/**` — that such a PR would NOT trigger this job. If
you have a live PR to check against, run `gh pr checks <PR#>` on one
that doesn't touch `services/cp-sat/**` and confirm this workflow is
absent from the list entirely (not present-and-skipped — absent).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cp-sat-service.yml
git commit -m "ci: path-filtered workflow for the cp-sat service"
```

**Verify**: workflow YAML is valid (`gh workflow view` doesn't error), and the `paths:` block matches exactly `services/cp-sat/**` and `proto/**` — no broader glob that would fire on unrelated PRs.

**Output cap**: final message under 15 lines — confirm path filter, confirm no other workflow file was touched.
