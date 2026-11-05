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
- In Simple, every feature anywhere it can be selected (Roadmap timeline and Gantt, Goal buckets, Priorities, Home,
  and every other page) opens the same feature panel: its details, what it depends on, what depends on it, its start
  and delivery estimate, the goal it serves and how that is measured. Each of these is editable there, including
  overriding Oracle's suggestion or an existing dependency. No page shows a feature that cannot be read or changed.
- A person always sees what is happening to a PRD or roadmap shared with them, and every change it needs can be made
  in the UI: each count or badge leads to the items it counts, each with the action that resolves it; acting removes or
  updates the item and every count at once, on every page; a running or scheduled run that will change a PRD or
  roadmap shows on its pages live; no needed change requires the API, CLD or a hidden page.
