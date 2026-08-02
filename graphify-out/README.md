# graphify knowledge graph

Built with [graphify](https://pypi.org/project/graphifyy/) over the whole repo
(scan root = repo root, not `apps/`). Tracked in git so a clone **updates** the
graph incrementally instead of re-extracting ~2.4M tokens from scratch.

| file | why it is tracked |
| --- | --- |
| `graph.json` | the graph itself; `--update` merges into it |
| `manifest.json` | per-file content hashes — what `--update` diffs against |
| `cache/semantic/` | the LLM-extracted fragments, the only expensive artifact |
| `.graphify_labels.json` | community names used by the report and the viz |
| `GRAPH_REPORT.md` | audit report |
| `cost.json` | cumulative token spend |

Everything else under `graphify-out/` is derived or machine-local and is
gitignored — including `cache/ast/` (regenerates free) and `graph.html`
(`graphify export html`).

## First-time setup in a fresh clone

`.gitattributes` routes `graph.json` through graphify's merge driver, which
merges two graphs semantically instead of leaving conflict markers in a 19 MB
file. Git will not run it until the driver is registered locally — this lives in
`.git/config`, which is **not** shareable, so every fresh clone must run:

```bash
git config merge.graphify.driver \
  "$(command -v graphify || echo graphify) merge-driver %O %A %B"
```

Worktrees share the parent clone's `.git/config`, so they need no setup.

## Refreshing the graph

```bash
graphify update   # re-extracts only files whose content hash changed
```

The SQL grammar is a separate extra — without it every `db/**.sql` migration
contributes zero nodes, silently:

```bash
uv tool install --upgrade 'graphifyy[sql]'
```

## Known scope cuts

- 102 images (`design/fix-ui/screenshots`, `apps/web/public`) are excluded from
  semantic extraction — vision costs one agent per image. They are deliberately
  left unstamped in the manifest, so an `--update` will queue them if wanted.
