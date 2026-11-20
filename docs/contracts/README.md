# Contracts

Each tree's tests read only their own tree (#1570). A value that crosses trees is published
here as JSON by its owner, and the other tree reads this copy. The prefix names the owner and
the check that keeps the copy the same as its source:

| Prefix | Owner | Check (rewrite) |
| --- | --- | --- |
| `api-*` | api/tests/fixtures | `api/tests/test_contracts_published.py` (`CONTRACTS_WRITE=1`) |
| `web-*`, `mock-*` | web/ | `web/e2e/contracts-published.spec.ts` (`CONTRACTS_WRITE=1`) |
| `docs-*` | docs/ | `python3 docs/contracts/check.py` (`--write` for the template hashes and YAML texts) |

The guards that throw on any other read of another tree: `api/tests/_own_tree_only.py`
(armed for every API test) and `web/lib/ownTreeOnly.ts` (armed by `web/e2e/test.ts`).
