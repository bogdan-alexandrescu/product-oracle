# Review rounds

1. Commit everything. Note the range: `origin/main..HEAD`.
2. Start the `change-reviewer` subagent with the range, the issue number and its acceptance
   line. It is read-only and reports verified defects only, in the verdict format of
   `docs/agents/lane-rules.md` (Reviewing a lane).
3. For each blocker and major: fix it with a red test first where it is a behaviour, rerun
   the scoped gates it touches, and commit. A finding you judge wrong gets a one-line reason
   in the PR body, not silence.
4. Start a new round on the new range. Stop when the verdict is `MERGE`, or after three
   rounds: then list what is open in the PR body and ask the owner.
5. Minors are fixed when cheap, otherwise listed in the PR body.
