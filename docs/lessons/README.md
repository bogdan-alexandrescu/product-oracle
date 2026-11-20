# Lessons

Incidents behind the rules, filed under the heading of the rule they gave. The rules
themselves live in `CLAUDE.md`, `docs/agents/lane-rules.md` and `.claude/rules/`; this file
holds only the why. Add an incident under its rule's heading (make the heading if it is new)
and keep the rule where it is, with a link here.

## Scratch goes under $TMPDIR, never a literal /tmp or the workspace

Rule: `docs/agents/lane-rules.md` (Building a lane).

- A lane filled the literal /tmp (3 GiB) and its pod was evicted; the attempt was lost. The
  workspace is at most 5 GiB and checkpointed, so scratch there costs every checkpoint.

## One heavy command at a time; the container has 8 GiB

Rule: `docs/agents/lane-rules.md` (Building a lane).

- A lane was OOM-killed: at the 8 GiB limit the kernel kills the whole container. `free -m`
  shows the host, not the container, so it did not warn; `/sys/fs/cgroup/memory.current` does.
