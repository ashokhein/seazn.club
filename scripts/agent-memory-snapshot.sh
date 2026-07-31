#!/usr/bin/env bash
# Snapshot .claude/agent-memory/ into a bare git repo outside the checkout.
#
# That directory holds every subagent's durable knowledge and is excluded
# from this repo on purpose (.git/info/exclude, "SDD infra"), so it has no
# history and no recovery path. In July 2026 an agent ran `rm -rf` on it
# while cleaning up a stray path and 23 topic files were lost for good.
#
# The backup lives outside the working tree, so it survives deletion of
# the directory it is backing up. Run it at wave boundaries, or wire it
# to a Stop hook in .claude/settings.local.json:
#
#   { "hooks": { "Stop": [ { "hooks": [ {
#       "type": "command",
#       "command": "$CLAUDE_PROJECT_DIR/scripts/agent-memory-snapshot.sh"
#   } ] } ] } }
#
# Restore:  git --git-dir=<backup> --work-tree=.claude/agent-memory checkout -- .
# History:  git --git-dir=<backup> log --oneline
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/.claude/agent-memory"
backup="${AGENT_MEMORY_BACKUP:-$HOME/.claude/backups/seazn-agent-memory.git}"

[ -d "$src" ] || { echo "agent-memory-snapshot: no $src — nothing to do"; exit 0; }

# One backup serves every checkout, so a linked worktree holding its OWN
# agent-memory would commit its thin copy over the main checkout's. Resolve
# symlinks first: a worktree that symlinks the shared directory (the intended
# setup — see docs/agent-playbook.md) lands on the same physical path and is
# fine. A real directory inside a worktree is a divergent copy; refuse it.
src="$(cd -P "$src" && pwd)"
git_common="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
main_root="${git_common%/.git}"
if [ -n "$main_root" ] && [ "$src" != "$main_root/.claude/agent-memory" ]; then
  echo "agent-memory-snapshot: $src is a worktree-local copy, not the shared memory." >&2
  echo "  Refusing — snapshotting it would overwrite the main checkout's backup." >&2
  echo "  Symlink it instead:  ln -s '$main_root/.claude/agent-memory' '$repo_root/.claude/agent-memory'" >&2
  exit 1
fi

# Refuse to snapshot a directory that has just been emptied: overwriting a
# good backup with an accidental deletion is the exact failure we exist to
# prevent. Override with FORCE=1 when the emptying was intentional.
file_count="$(find "$src" -type f ! -path '*/.git/*' | wc -l | tr -d ' ')"
if [ "$file_count" -lt 2 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "agent-memory-snapshot: only $file_count file(s) in $src — refusing to overwrite the backup." >&2
  echo "  If this is intentional, re-run with FORCE=1." >&2
  exit 1
fi

if [ ! -d "$backup" ]; then
  mkdir -p "$(dirname "$backup")"
  git init --bare --quiet "$backup"
  echo "agent-memory-snapshot: created backup repo at $backup"
fi

# A worktree-scoped git dir inside the source would itself be deleted by the
# `rm -rf` we are guarding against, so drive git entirely from the outside.
export GIT_DIR="$backup"
export GIT_WORK_TREE="$src"

git add -A
if git diff --cached --quiet 2>/dev/null; then
  echo "agent-memory-snapshot: no changes ($file_count files)"
  exit 0
fi

git -c user.name='agent-memory-snapshot' \
    -c user.email='snapshot@localhost' \
    commit --quiet -m "snapshot: $file_count files at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "agent-memory-snapshot: committed $file_count files to $backup"
