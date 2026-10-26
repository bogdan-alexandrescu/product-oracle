# Product Oracle v2: PRD quality, readiness and organizational learning (CR-08)

Lane `v2-quality`, build prompt §10, wave plan [waves.md](waves.md). API and logic only
(I3, 2026-10-19): the screens are listed at the end for the UI wave. Owner decisions in
[docs/questions.md](../questions.md) take precedence.

## 1. The policy: T2, decided

**T2 PRD quality policy, answered by the owner on 2026-10-19: advisory evaluation, gate
criticals only.** Ten criteria, each `pass / warning / critical / not_applicable`, with a
rationale, evidence and an owner. A publish is blocked only by review and publish
invariants, a critical unresolved hard blocker, or a failed critical security or policy
check (unsupported third-party operation included). A quality rating alone never blocks,
and there is no universal numeric publish score.

How the code holds to it:

| Rule | Where |
|---|---|
| The ten criteria are registered **advisory** (`hard=False`). Their `critical` is shown, never a stop. | `oracle/quality/criteria.py` `register()`; `tests/test_quality_policy.py` |
| This lane registers exactly two **hard** checks: `security_policy` (a failed critical security, privacy or policy requirement) and `third_party_support` (the PRD relies on an operation a provider does not support or permit). | same |
| Approvals and the critical-hard-blocker gate are not here: `v2-review` and `v2-blockers` register those. | waves.md, the two hooks |
| No numeric score, threshold or weight anywhere in the catalogue or the dashboard. | `test_no_numeric_publish_score_exists` |
| Model output is never hard and never feeds a check. | `oracle/quality/judge.py`; `tests/test_quality_judge.py` |
| §16 item 11: a PRD failing every advisory criterion is not blocked. | `test_every_advisory_criterion_critical_never_blocks`, the `bad-prd-sections` corpus case |

## 2. The ten criteria

Every criterion is deterministic: named patterns and graph facts a person can check, so
the rationale says exactly what was found. Each result carries `evidence_ids` (entity,
evidence, gap, conflict, option, experiment or dependency ids), an `owner_id` (the gap's,
blocker's or experiment's owner when one applies, else the version's approver or author)
and `section_keys`.

| Key | Question | Critical when | Warning when | Not applicable when |
|---|---|---|---|---|
| `problem_clarity` | Who has the problem, what is it, what shows the pain? | No problem section, under 15 words, or a critical open user/pain gap | No users named; no evidence, citation or answered pain question | never |
| `goal_alignment` | Does every feature serve a confirmed goal, and how does it rank? | A linked feature serves no confirmed goal (F3b, `baseline.trace`), with its goal-weighted rank; no confirmed goal in the baseline; no goals section; a critical goal gap | A goal link with no contribution; goals named in words only; proposed goals | never |
| `evidence_provenance` | Fresh, confident evidence without open conflicts? | An open **material** conflict; no evidence and no citation at all | All evidence below the company's `low` confidence; stale evidence; important claims still a hypothesis or AI inference; claim links without evidence | never |
| `alternatives_tradeoffs` | Two approaches compared, with the trade-off? | A critical alternatives gap | Fewer than two options or no trade-off stated | never |
| `blocker_feasibility` | Every blocker has a workable, compliant mitigation or an experiment? | A hard or critical blocker with no compliant option and no experiment; a policy, eligibility or permission limit "accepted as a risk"; a critical blocker gap | Open with options but none selected; a risk accepted without a recorded decision; nothing recorded and no risks section | never |
| `scope_testability` | Explicit scope and non-goals; testable acceptance criteria? | No scope section; no acceptance criteria; half or more untestable (vague words, no number, no observable condition) | Some untestable; requirements without a `verifies` criterion; no non-goals | never |
| `economics_scaling` | Costs, benefits, scaling stated and quantified, kept as configuration? | A critical economics gap | Open economics gaps; tenant-specific behaviour written into requirements (configurability leakage); no section; no numbers | No economics or scaling section, module, gap or leakage |
| `validation_plan` | Measurable metrics, a decision threshold, a validation plan? | No metrics; a critical metric gap | Metrics without numbers; no threshold; no plan or experiment | never |
| `ownership_readiness` | An owner, a rollout and operations plan, review under way? | No owner in front matter, text or `owned_by` links; a critical ownership gap | No operations plan; no comment or verdict yet | never |
| `downstream_consistency` | Are specs, designs and roadmaps from this PRD still consistent? | never (advisory warning is enough) | A dependency `potentially_stale` or `under_review`; a roadmap built from an older version | No downstream artifact |

The two hard checks:

| Key | Critical (blocks a publish) | Warning | Not applicable |
|---|---|---|---|
| `security_policy` | A linked requirement, constraint or risk with `attrs.policy = {critical: true, status: "failed"}` | A critical one still `unverified`; a critical security gap | None linked |
| `third_party_support` | `attrs.third_party.supported = false` (eligibility, permission or policy) while the plan still relies on it, or its blocker was "accepted as a risk" | Support not verified yet | No third-party operation |

`third_party_support` keeps rate and capacity limits apart from eligibility, permission and
policy (§16 item 8): a capacity limit is never a permission failure. The operation is no
longer relied on when its blocker is `resolved` or `feasibility_only`, or has a selected,
compliant option (a selected option is always compliant: the foundation's check
constraint). The rationale names the compliant option.

### Typed attrs the hard checks read

On baseline entities, through the existing entity routes (no new write path):

```yaml
attrs:
  policy:        # PolicyRequirement, on a requirement, constraint or risk
    area: security | privacy | platform_policy | legal | compliance
    critical: true
    status: met | unverified | failed
    note: "..."
  third_party:   # ThirdPartyOperation, on any linked entity (usually a blocker constraint)
    provider: "Example social network"
    operation: "automated posting on a member's behalf"
    limit_kind: rate_capacity | eligibility | permission | policy
    supported: true | false | null
```

A blocker (`attrs.blocker`, the foundation's `BlockerAttrs`) with `limit_kind` eligibility,
permission or policy counts as a third-party operation even without `attrs.third_party`.

### What a document's scope is

The entities its sections link (`document_section_links`, for the version or unversioned),
the entities its gaps name, and blockers whose `impacted_entity_ids` touch those. A legacy
document with no links is judged from its text, citations and gaps; its hard checks are
`not_applicable` (nothing linked to check), which is recorded as an open risk below.

### Reuse

- Goal traceability: `oracle.baseline.trace.report` (flags `serves_no_goal`).
- Priority: `oracle.priorities.service.load_features(rescore=False)` and
  `priorities.scoring.rank(..., "goal_weighted")`; the rationale quotes each orphan
  feature's rank and score. `rescore=False` is a new keyword: readiness checks never write.
- Confidence: the company's `confidence_weights.low`; freshness from the evidence's
  `confidence_factors`.

## 3. Light judging (model output)

A new built-in job kind, `quality_review`, runs on Oracle's Claude account pool through
the existing worker, gateway, accounting and retry rules (P3b, C1c). It is only ever
queued by an approver (`POST .../quality-review`), and an owner can turn it off per
document like the other kinds (`JobSettings.quality_review`).

- The prompt (`oracle/jobs/prompts/quality_review.v1.md`) gets the sections and the ten
  criteria, **not** the rules' verdicts, so its opinion is independent. Section text is
  framed as data, never instructions.
- The answer becomes an `evaluation_reports` row with `evaluator = "llm_job"`,
  `summary.label = "model_output"` and a disclaimer; findings are never `hard`. Unknown
  keys or statuses are dropped; an answer with none valid is retried once, then fails.
- The dashboard shows it beside the rules with an agreement flag. The rules keep the
  status. It is not ground truth.

Human ratings (`POST .../evaluations/human`, commenters and up) are stored as
`evaluator = "human"` reports and compared the same way (share of raters agreeing).

## 4. The evaluation corpus

`api/tests/fixtures/eval/` (README there): synthetic, redacted cases with expected statuses,
run by `tests/test_quality_corpus.py`. Each §10 case is covered:

| §10 case | Corpus case(s) | Pinned result |
|---|---|---|
| good / bad PRD sections | `good-prd`, `bad-prd-sections` | all pass; most criteria critical yet not blocked |
| conflicting evidence | `conflicting-evidence` | `evidence_provenance` critical |
| uncertain claims | `uncertain-claims` | `evidence_provenance` warning (low confidence, stale, hypothesis) |
| missing goals | `missing-goals` | `goal_alignment` critical, with the feature's rank |
| untestable acceptance criteria | `untestable-acceptance` | `scope_testability` critical |
| blockers with no workable mitigation | `blocker-no-mitigation` | `blocker_feasibility` critical (advisory; the blockers lane gates it) |
| policy-sensitive social API constraints | `social-api-policy`, `social-api-compliant`, `social-api-risk-accepted` | hard `third_party_support` critical and blocked; pass with the compliant alternative; still critical when "risk accepted" |
| tenant-configurability leakage | `tenant-config-leakage` | `economics_scaling` warning |
| stale derived specs | `stale-derived-spec` | `downstream_consistency` warning |
| (also) failed critical security requirement | `failed-security-requirement` | hard `security_policy` critical, blocked |
| (also) legacy document | `legacy-document` | evaluates from text alone, no error |

Two cases carry synthetic human ratings and a canned model answer, to test the comparison
(`oracle/quality/compare.py`). No real rater data exists yet; the comparison is built and
reported, never enforced.

## 5. Post-publish outcome tracking and learnings

| Table (migration `0014_quality`) | Why |
|---|---|
| `outcome_records` | Links what launched to the goal it serves: an **approved** PRD version, a roadmap item (a section of a roadmap version), a feasibility experiment, and optionally a baseline `outcome` entity. Holds the prediction (metric, baseline, predicted, threshold, by), the modules and question categories it rested on, the status (`tracking`, then `held`, `partially_held`, `not_held` or `inconclusive`) and every assessment (append-only). |
| `quality_learnings` | What the company keeps: a statement about a module key, a question category or a criterion, with a direction (`recommend_more`, `recommend_less`, `note`), a weight 1-3, active or retired. |

An assessment returns **drafted** learnings (from the outcome's modules and question
categories); a person keeps the ones that matter. `GET /v1/learnings/signals` sums active
learnings per target (+weight, -weight, 0 for notes): the input future module and question
recommendations read. Nothing here writes to documents, versions, sections or
compositions; `test_tracking_never_changes_a_published_document` pins it.

Later recommendations read the active learnings (`oracle/quality/learned.py`; retired ones
never count). Each point of net signal moves a question's rank score by 10% of itself and
a module's 0-1 advisory score by 0.1, capped at 20% (0.2) either way, so one signal never
outweighs a gap's importance:

- **Module recommendations** (the composer): every module a learning names says so in its
  explanation ("Recommended because of a learning from past outcomes: ..."), and its
  advisory score moves by at most the cap. A recommend_more learning suggests an optional
  module nothing else brings in (`decided_by: learning`); learnings never drop a module
  and never override company policy, a condition that held, the template or a person's
  decision. Recomputed each revision, like a condition.
- **Intake questions**: a question category's learnings move its rank score (the order of
  questions not asked yet, at the next sync) and its rationale says why. Each sync keeps
  the nudges it ranked with on the intake (`analysis["learned"]`, by gap): a gap whose
  question was asked keeps the one it was last ranked with. Every reader (the author,
  anyone else, a run) ranks with those, so asked questions are never re-ranked and a
  learning added or retired since moves no one's order until the next sync. A rationale
  reworded for others keeps the "Recommended because ...". The gap list's own
  expected-effect ranking is unchanged. `tests/test_learnings_tune.py` pins both.

## 6. Routes (all `/v1`, all MCP tools by operation id)

| Route | Role | Audit | What |
|---|---|---|---|
| `GET /quality/criteria` (`list_quality_criteria`) | viewer | | The ten criteria, then the two hard checks |
| `GET /documents/{doc}/versions/{n}/readiness` (`get_document_readiness`) | viewer (run tokens with `read:documents`) | | The live dashboard: every registered check (other lanes' too), the model view, human ratings, agreement, `blocked` and `blocking`. Stores nothing. |
| `POST /documents/{doc}/versions/{n}/evaluations` (`create_evaluation_report`) | commenter | `evaluation_report.created` | Snapshot of every check as a `rules` report |
| `POST /documents/{doc}/versions/{n}/evaluations/human` (`create_human_rating`) | commenter | `evaluation_report.created` | A person's rating of some criteria |
| `POST /documents/{doc}/versions/{n}/quality-review` (`queue_quality_review`) | approver | `llm_job.queue` | Queue the model review |
| `POST /outcomes`, `GET /outcomes`, `GET /outcomes/{id}` | approver / viewer | `outcome.created` | Track and read outcomes |
| `POST /outcomes/{id}/assessments` (`assess_outcome`) | approver | `outcome.assessed` | Record whether it held; drafted learnings |
| `POST /learnings`, `GET /learnings`, `GET /learnings/signals`, `POST /learnings/{id}/retire` | approver / viewer | `learning.created`, `learning.retired` | Keep, read and retire learnings |

Stored reports are read through the foundation's `GET /v1/evaluation-reports[/{id}]`.
Another company's ids are 404 on every route (tests). Mock fixtures:
`web/lib/api/mock/quality.ts`.

## 7. Open risks

- **Linking is what makes hard checks bite.** A PRD whose sections link nothing has its
  hard checks `not_applicable`. The trace and intake lanes create links; the publish
  transaction (review lane) could require a composition or links for new PRDs.
- **Heuristics are English-only and pattern-based** (vague acceptance words, owner lines,
  tenant-specific phrases). They are explained and pinned by the corpus; expect tuning as
  real PRDs arrive.
- **The model review is uncalibrated.** No human-rated corpus exists yet; agreement is
  shown, not trusted.
- **One visible UI effect**: the existing Jobs panel lists the new kind (its per-document
  toggle and its jobs) because the panel iterates the job kinds in `web/lib/format.ts`.
  Recorded as QUA-1 in [change-requests.md](change-requests.md).
