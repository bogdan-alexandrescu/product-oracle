# Product Oracle rules

- UI copy uses plain, short words: no jargon, no code or id shown without its name ("F-26 Keys out of checkpoints", never "F-26").
- Dates read month first everywhere a person sees them, in the UI and in exports: "Oct 31", "Oct 30, 2026, 2:49 PM PDT"; never ISO.
- Roles in the web go through can() or an item's own can_* field only; never compare role names in components.
- No company or customer data in code, tests, fixtures, mock data, commit messages or PR text: tests use invented example data (example.com addresses, made-up people and products).
- The mock API (web/lib/api/mock) matches the real API for every route and field a page reads.
- Every user-facing change has a mock-backed Playwright spec in web/e2e that drives the UI as a person would and fails without it.
- Every API change has a pytest test that fails without it; red tests are committed before the fix.
- Simple pages keep the owner's picked mock-up designs exactly; behaviour and text change within the design as built.
- One alembic head: a new migration chains after the branch's own head.
- Never use pkill, killall or kill on a pattern; kill by PID only.
- Logs and temp files go under $TMPDIR or the job's own folder, never a literal /tmp.
- A generated text shown to people never carries raw tokens such as [c:c4], template labels or internal file names.
