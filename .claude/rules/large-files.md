# Large files

- Never read a whole file over about 2,000 lines. Find the place first (`grep -n`, Grep, or
  the code-graph skill), then read a range: Read with an offset and a limit of a few hundred
  lines, or `sed -n 'START,ENDp'`.
- The large source files today: `api/oracle/runs/service.py` (about 12k lines),
  `web/lib/api/mock/server.ts` (about 10k), `web/lib/api/mock/runs.ts`,
  `web/lib/api/mock/simple-*.ts`, `web/app/simple/priorities/priorities.tsx`,
  `api/tests/test_adapter_v2.py`. Check a file you have not met with `wc -l` first.
- Generated and bulk files (`web/lib/api/openapi.json`, `web/lib/api/schema.d.ts`,
  `api/oracle/roadmap/unicode/confusables.txt`, the lockfiles, the design PNGs) are listed in
  the root `.ignore`, so Grep and Glob skip them. Never read them; regenerate them
  (`make openapi`). A census that must see every file uses `git grep` or `rg --no-ignore`.
- A tool result too large to show is saved to a file: `grep -n` it, then read it by range.
- A broad search that would pull many files into context goes to the `explorer` subagent,
  which returns the answer and `path:line`, not the files.
