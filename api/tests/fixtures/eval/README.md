# PRD quality evaluation corpus (CR-08)

Synthetic, redacted fixtures for `oracle/quality`. Nothing here is real company data:
every product, metric, provider and person is a placeholder.

Each file in `cases/` is one test (`tests/test_quality_corpus.py`):

| Key | What |
|---|---|
| `id`, `description` | The case and why it exists. |
| `covers` | The build prompt §10 corpus cases it stands for (the test checks every one is covered). |
| `document` | `markdown:` inline, or `from:` a base file here, with `replace:` (section key → new body) and `drop:` (section keys). |
| `baseline` | Entities (`ref`, `type`, `key`, `title`, `status`, `attrs`), `edges`, `evidence` (`confidence`, `freshness`, `age_days`), `conflicts`. |
| `links` | Section links: `section` → entity `ref`, with `kind` and `precision`. |
| `gaps`, `decisions` | Knowledge gaps and assumption decisions on the document. |
| `blockers` | Constraint entities with `attrs.blocker`, their `options` and `experiments`. |
| `artifacts` | Downstream artifact dependencies on a section, with `freshness`. |
| `reviews` | Section verdicts and comments on the version. |
| `expected` | Criterion or hard check → `pass`, `warning`, `critical` or `not_applicable`. |
| `blocked` | Whether the quality lane's checks alone block a publish (only its hard checks can). |
| `rationale_contains` | Criterion → words its rationale must contain (explainability). |
| `human_ratings`, `model_output` | Synthetic rater and model answers, used to test the comparison. They are labelled as such and never treated as ground truth. |

The expected statuses are what the deterministic rules must return. Changing a rule means
changing the expectation here in the same PR, with the reason.
