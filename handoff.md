Fix 1 for PR 1273 (an approved PRD's items show once on the Simple roadmap). Fixes the review's three majors and two minors.

## What changed
- **A change to a folded item lands on both layers** (`api/oracle/simple/drafts.py`). `write_items` and `simulate` (a proposal's as-if read) now write the same after-values into the draft copy's overlay too, whenever the target has a copy in the draft with the same roadmap, PRD and key. So the folded read always shows the latest change, even when that change puts back the shown item's own stored value. This fixes:
  - restore after a cut made on the copy;
  - moving dates back to the shown item's stored dates;
  - setting a title back.

  Both `twins` and the copy lookup now pick the first copy by id, so the item the read folds is the item that gets written.
- **Banner count** (`prd_roadmap.py`, `sources_out` → `there()`): a copy that folds into an item on the shown version is now counted from the folded item (`drafts.fold`). A cut folded item is no longer counted, and the item counts once.
- **Fit-date** (`fit_date_router.py`, `_roadmap_follows`): it now matches the PRD's items against the shown version, the same way approval does, instead of the draft's base. A folded item's re-plan also writes onto its copy.
- **Mock** (`web/lib/api/mock/simple-roadmap.ts`): `approvedPrdToDraft` matches by key, then feature, then title. A new `foldPrdCopies` folds an existing copy on read (and before approval), so a mock page shows one item wherever the API shows one.
- Submit's 409 (base older than the newest version) is left alone; another lane handles it. No migration.

## Tests
- Red tests (commit e6ed17cb, committed before the fix): restore after a copy's cut; a date move back to the shown item's dates; a title set back; the banner count after cutting a folded item; a copy from a different PRD with the same key stays its own item (a guard: it passes both before and after); fit-date writes on the shown version.
- `test_a_proposal_on_a_folded_item_reads_as_applied_on_both_layers` covers `simulate`. It was added after the fix. I checked that it fails when the copies argument is not passed.
- e2e: in `approved-prd-shown-once.spec.ts`, "a copy the draft holds already shows as the one item it copies". It fails without the mock fold: it shows end 2026-12-10 instead of 2027-02-19.

## Checks
- ruff check and format: clean.
- pytest on Postgres 16, `-n 2`, all passed:
  - approved_prd_roadmap with all fit_date* files: 57, then approved_prd_roadmap again after the simulate test: 18;
  - drafts_api, drafts_migration, drafts_published, additions_api, cut_dependents_api: 40;
  - simple_roadmap_api, simple_changes_api, test_changes: 45.
- web: `next typegen`, `tsc --noEmit` and `lint` all pass.
- Playwright against the production mock build:
  - approved-prd-shown-once and approved-prd-roadmap: 4 passed.
  - every `*simple-roadmap*` and `*fit-date*` spec: all passed except one. `simple-roadmap-filter-review` "PRD, Goal and Track picks are remembered" (phone) failed once and passed on rerun.
Status: all done and committed (e6ed17cb, 5c42e21d, 16471044, e24d19c2).
