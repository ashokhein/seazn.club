# pnpm worktree-install benchmark — results

Measured 2026-08-05 on the dev machine (Darwin 23.6.0, APFS), against the
stage-3 lockfile. This is task 3.4 of the TypeScript 7 / node 26 / pnpm
migration.

## What question this answers

The stage exists for one reason, in the owner's words: *"when we create the
worktree, and if you do install, then it installs quickly right?"*

So the measurement is **the cost of standing up an additional worktree**, not
pipeline speed. Pipeline speed was already benchmarked in #158 and npm won cold;
nothing here revisits that, and nothing here should be quoted as if it did.

## Headline

| | npm ci | pnpm (warm store) |
| --- | --- | --- |
| time for a new worktree | 76–100 s | **31–32 s** |
| real disk per worktree | **1231 MB** | **29–72 MB** |

Roughly **3× faster and ~20–40× less disk** per additional worktree.

The first install on a fresh machine is a wash — pnpm cold-store was 74 s
against npm's 85 s in the same conditions. pnpm's win is entirely in the
*second and subsequent* trees, which is exactly the case that motivated it.

## Timings

Load is recorded beside every number. A 4× swing purely from a neighbouring
session's load has been observed on this box, so an unqualified timing here is
not a measurement. The final two rows alternate npm and pnpm back-to-back so
that any drift in background load hits both sides equally — those are the pair
to trust.

| run | load at start | npm ci | pnpm warm |
| --- | --- | --- | --- |
| first pass | 5.07 / 59.53 | 85 s | 16 s |
| second tree | 10.91 / 50.37 | 24 s | 18 s |
| third tree | — / 13.29 | — | 13 s |
| **alternating 1** | **54.12 / 51.99** | **100 s** | **31 s** |
| **alternating 2** | **34.32 / 22.62** | **76 s** | **32 s** |

npm ranged 24–100 s and pnpm 13–32 s. The 24 s npm outlier is not explained and
is left in rather than dropped; taking it at face value still leaves pnpm ahead
on every paired comparison. The conservative claim is **~2.4–3.2× on the paired
runs**, and up to 5× when the box is quiet.

## Disk — and why `du` cannot answer this

pnpm on this filesystem does **not** use hardlinks. Sampled files in the store
and in a tree have link count 1 and *different inodes*, which means APFS
copy-on-write clones. `du` reports the full logical size for every clone, so it
shows ~1.1 GB per tree and 3.4 GB across three trees — an accounting artifact,
not disk that exists.

Real allocation, from `df` deltas around each install:

| | measured |
| --- | --- |
| pnpm warm tree #5 | 38 MB |
| pnpm warm tree #6 | 29 MB |
| pnpm warm tree #7 | 72 MB |
| npm ci tree | 1231 MB (matches its `du` of 1.2 G) |

npm's `df` delta agreeing with its `du` is the control: the method works, and
the pnpm figures really are two orders of magnitude smaller.

One earlier pnpm `df` delta came out at **−978 MB** — free space *grew* during
the install, because unrelated disk activity swamped the signal. That reading is
discarded, not averaged in. It is recorded here because a single negative delta
is the tell that this measurement needs repeating rather than reporting.

One-time cost: the content-addressed store is **1.1 GB**, paid once per machine
rather than per worktree.

## Method

- Manifest-only trees (`package.json` ×3, lockfile, `pnpm-workspace.yaml`)
  rather than real `git worktree add`. Install cost is identical and it leaves
  nothing behind in the repo's worktree list.
- `--ignore-scripts` on both sides, so this compares install work rather than
  postinstall builds.
- npm side uses `package-lock.json` from `270fe0cb`; pnpm side uses the ported
  `pnpm-lock.yaml`, which resolves to byte-identical versions — see the lockfile
  port in `f0da8a60`. Comparing against a drifted lockfile would have measured a
  different dependency set.
- `sync` before each `df` read.

## Caveat worth carrying

Every number here is from one machine with a busy neighbour. The disk result is
robust (two orders of magnitude, three consistent samples, plus a working
control). The timing result is directionally solid but the spread is wide —
treat "~3×" as the claim and not the 5×.
