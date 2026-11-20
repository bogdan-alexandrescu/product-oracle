# PR, merge and the serving check

## PR

- Push the branch and open the PR: `gh pr create --base main --title "<subject>" --body-file <file>`.
- The body says:
  - `Closes #<n>.` for each issue it closes;
  - what changed, in a few lines;
  - the gate verdict lines, one per gate, as the runners printed them (pytest, Playwright,
    tsc, lint, ruff, alembic heads), and the `MUTATE: OK` line of each planted defect;
  - gates not run, with the reason; review findings left open or judged wrong, with the reason.
- No company or customer data in the title, body or commits.

## Merge

- Wait for CI on the PR; a red check is fixed, never bypassed or rerun until it passes.
- Merge with a merge commit, never squash or rebase: `gh pr merge <pr> --merge`.

## The serving check

- The work is done when the merge commit is serving, not when it is merged. Find the merge
  commit (`gh pr view <pr> --json mergeCommit`), and confirm the running app was built from
  it or a later commit of main: on a local stack, `git pull` main and `make up`, then
  `curl -s localhost:8000/healthz`; elsewhere, the deploy's own record of the commit it built.
- Then test the change through the UI as a person would (root `CLAUDE.md`, Feature loop).
- Report the merge commit, how you saw it serving, and anything left.
