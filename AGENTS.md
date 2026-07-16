<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:session-handoff -->
## Session handoff protocol

**Session start:**
- If `HANDOFF.md` exists, read it FIRST — before exploring the codebase.
- Trust its contents. Do not re-verify or re-derive anything it states
  unless the code visibly contradicts it. Do not re-read files listed
  under "Done" unless the task requires editing them.

**Session end** (when I say "wrap up", "handoff", or "hf"):
1. Run the verify command from HANDOFF.md and note the result.
2. Rewrite `HANDOFF.md` in place, keeping its section structure:
   - Status, Current task, Done, In progress, Next steps,
     Key decisions, Gotchas, Verify.
   - Under 60 lines. Exact file paths. No narrative or praise.
   - "Next steps" item #1 must be concrete enough to start with zero
     other context.
   - "Key decisions" is append-only: add new entries with dates,
     never delete old ones.
3. Suggest a one-line commit message for the session's work.

**Mid-session safety:** if context is getting long and compaction is
likely, update HANDOFF.md *before* continuing risky or complex work.

## Compact instructions
When compacting, preserve: current task state, files touched this
session, decisions made, and the latest test results.
Drop: full file contents already committed, exploration dead ends,
and resolved error output.
<!-- END:session-handoff -->
