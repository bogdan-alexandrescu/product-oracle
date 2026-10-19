# Product Oracle v2: evidence-aware intake and the question engine (CR-03)

Lane `v2-intake`, build prompt §5 and §13 steps 1-6, plus the snapshot lock from CR-12.
Wave plan: [waves.md](waves.md). Built on the foundation ([01-solution-architecture.md](01-solution-architecture.md)):
`product_intakes`, `knowledge_gaps`, `stakeholder_questions`, `stakeholder_answers` and
`assumption_decisions`. API and logic only (I3, 2026-10-19: the UI follows the design
system). Readiness and PRD quality are `v2-quality`'s ([03b](03b-quality-and-readiness.md)).

## 1. What it does

A user writes a brief of a couple of sentences ("New product idea"). Oracle pins a
snapshot of that user's sources (or one they choose), reads the baseline, and builds a
**gap registry** over the seventeen §5 categories. It asks only the material questions
it could not answer itself, in short ranked batches, and records every answer in a
**question and answer ledger**. Answers update their gaps and propose changes elsewhere;
nothing is applied without a person. Unresolved critical blockers reach the review gate.

| Step (§5) | Where | How |
|---|---|---|
| 1. Extract from the brief and the pinned snapshot | `oracle/intake/extract.py`, `job.py` | Rules extract users, problem, outcomes, scope, non-goals, dependencies and blockers from the brief, and classify relevant pinned items by category. The built-in `intake_analysis` job adds model inferences on the Claude account pool. |
| 2. Baseline and locked data first; never re-ask | `engine.coverage_from_baseline`, `engine.sync_questions` | A confirmed goal the brief matches covers goal alignment; its metric and target cover the success metric; a named owner covers ownership; a confirmed matching constraint covers constraints and blockers; a gap decided for the same PRD (another intake) covers its category. Covered categories get no gap and no question. One question per gap, ever: an answered question is never asked again (409), and re-analysis never drafts a second one. |
| 3. Label every item | every extracted item and gap | `verified_fact` (an answer backed by the answerer's own source items), `user_decision` (a person's answer, or a confirmed baseline item), `ai_inference` (Oracle read it into a source item; carries the items' confidence), `hypothesis` (only the brief says it), `unknown`. Confidence is shown as how much evidence counts, never as proof. |
| 4. Conflicts and staleness | `extract.from_sources`, `summary.conflicts` | Pinned items that state different percentages for the same measure are a conflict, with the B3 recommendation from `baseline.conflicts.pick_winner` (confidence, then code > tracker > docs > meetings > chat, then newer). Open baseline conflicts on the goals, features and constraints the brief touches are listed with their resolution. Pinned items with freshness ≤ 0.35 are stale. |
| 5. Rank | `categories.rank_score` | importance weight (critical 4 … low 1) × the areas a missing answer affects (goals 3, feasibility 3, scope 2, economics 2, risks 2, module selection 1) × the unknown share (unknown 1, brief hypothesis 0.9, an inference 1 − its evidence confidence, kept between 0.2 and 0.6). Signals in the brief raise importance: a partner API makes third-party policy critical, personal data makes security critical, a rate limit makes blockers critical, a model-driven feature raises evaluation criteria. |
| 6. Short batches, every path | `engine.ask_batch`, `answers.answer` | Batches of five (1-10). Each question offers `answer`, `dont_know`, `defer`, `delegate` (to a company member who can answer) and `research`. A delegated question can be answered only by the person asked or an approver. |
| 7. Proposals, never approvals | `answers._propose_baseline`, `_propose_patch`, `propose_research` | An answer proposes a baseline entity (outcome, constraint with `attrs.blocker`, risk or decision) in the baseline's proposals; a `decision` change event through `oracle/changes.py` for the modules lane; a `prd_patch` when the intake is linked to a PRD (accepting it opens a feedback item on the latest version, refused on an approved section); a `research_run` for "Research this" and for "I don't know" on a critical gap. |
| 8. The review gate | `oracle/intake/checks.py` | `intake.critical_blockers` (hard) is critical while a critical blockers or third-party-policy gap of the PRD is unresolved; `intake.open_decisions` (advisory) warns on other critical gaps. An owner lifts either by accepting the risk or assumption with a rationale (`POST /v1/gaps/{id}/decisions`). |

All seventeen categories are covered: customer/user, pain evidence, company-goal
alignment, success metric and baseline, differentiation, alternatives, current and future
constraints, blockers, economic benefit, effort and cost, security and privacy, team
ownership, non-goals, release and rollout, evaluation criteria, third-party policy and API
limits, configurability and scaling (`categories.CATEGORIES`).

## 2. The snapshot lock (CR-12, S4)

- An intake pins a snapshot at creation (`snapshots`, as of the database clock) or one the
  author picks; `product_intakes.source_snapshot_ids` keeps every pin, and the last is the
  one it reads. "Version N" is the Nth pin.
- Every read goes through `oracle.sources.items.items_as_of`, so later syncs do not reach
  the analysis. Re-analysis on the same pin gives the same gaps.
- `GET /v1/intakes/{id}/new-evidence` lists the author's items added, changed or deleted
  since the pinned version: the "new evidence since version X" shown before a redraft.
- `POST /v1/intakes/{id}/repin` (author or approver) pins anew and re-analyses. A decided
  gap (answered, validated, accepted risk, deferred) is never touched, not even its
  `lock_version`; new evidence reaches open gaps only.
- A run started from an intake (`POST /v1/intakes/{id}/runs`, or an accepted research
  proposal) carries `intake_id`, `intake_snapshot_id` and, for research, `intake_gap_ids`
  as Oracle knobs. `runs.service.start` reads the intake's snapshot instead of taking a
  new one. The agents' prompt names the intake id and the tools to read it with, never its
  text.

## 3. Untrusted content

- Source text is data. In the API it only appears as `data_excerpt` on an `EvidenceRef`
  with `untrusted: true`, and only to the item's owner (S3 as built, AUD-9: others see that
  evidence exists, its kind and confidence).
- The `intake_analysis` job's system prompt is the fixed file
  `api/oracle/jobs/prompts/intake_analysis.v1.md`. The brief and the source excerpts go
  only inside the user message's `untrusted_data`, which the prompt declares is never an
  instruction. The answer is validated: known fields and categories, text cut to 500
  characters, evidence refs that resolve to items the job was given. Results are AI
  inferences and open gaps only; the job can neither answer nor close anything.
- Runs get the intake id, not its text. Run tokens read intakes, gaps, questions and
  answers with `read:baseline`; the two routes that return source content
  (`/intakes/{id}/evidence`, `/intakes/{id}/new-evidence`) need `read:sources`; run
  tokens can never answer, decide or accept.
- Every evidence search is audited (`intake.evidence_query`: query, hits, item ids, pin).

## 4. Routes (all `/v1`, all MCP tools)

| Route | Tool | Role | Screen |
|---|---|---|---|
| `POST /intakes` | `create_intake` | commenter | New product idea |
| `PATCH /intakes/{item_id}` | `update_intake` | commenter (author) or approver | New product idea |
| `GET /intakes/{intake_id}/summary` | `get_intake_summary` | viewer | Opportunity and Gaps |
| `POST /intakes/{intake_id}/analyze` | `analyze_intake` | commenter | Opportunity and Gaps |
| `GET /intakes/{intake_id}/new-evidence` | `get_intake_new_evidence` | viewer | Opportunity and Gaps |
| `POST /intakes/{intake_id}/repin` | `repin_intake` | author or approver | Opportunity and Gaps |
| `GET /intakes/{intake_id}/evidence?q=` | `search_intake_evidence` | viewer (own items) | Evidence panel |
| `GET /intakes/{intake_id}/question-batch` | `get_question_batch` | viewer | Question batch |
| `POST /intakes/{intake_id}/question-batches` | `ask_next_question_batch` | commenter | Question batch |
| `GET /intakes/{intake_id}/composition-inputs` | `get_intake_composition_inputs` | viewer | (modules lane) |
| `POST /intakes/{intake_id}/runs` | `start_intake_run` | approver | Opportunity and Gaps |
| `GET /intakes/{intake_id}/proposals` | `list_intake_proposals` | viewer | Proposals |
| `POST /intake-proposals/{id}/accept`, `/dismiss` | `accept_intake_proposal`, `dismiss_intake_proposal` | approver | Proposals |
| `POST /gaps`, `PATCH /gaps/{item_id}` | `create_knowledge_gap`, `update_knowledge_gap` | commenter, approver | Opportunity and Gaps |
| `POST /gaps/{gap_id}/decisions` | `decide_knowledge_gap` | approver; owner on a critical gap | Opportunity and Gaps |
| `POST /gaps/{gap_id}/research` | `propose_gap_research` | commenter | Question batch |
| `POST /questions/{question_id}/answers` | `answer_question` | commenter (the person asked, or an approver) | Question batch |

The foundation's list and get routes (`list_intakes`, `get_knowledge_gap`, …) stay as
they are. Every write is audited (`intake.*`), and another company's id is a 404.

## 5. Schema

One additive migration, `0014_intake` (down_revision `0013`, re-chained at merge):
`intake_proposals` (what an intake proposes until a person decides) and, on `llm_jobs`,
`intake_id`, a nullable `document_id`, the `intake_analysis` kind and a check that a job
has a document or an intake. Gaps, questions, answers and decisions use the foundation's
tables unchanged; the chosen sources and the analysis live in `product_intakes.analysis`.

## 6. Interfaces for the other lanes

- **Modules:** `GET /v1/intakes/{id}/composition-inputs` returns the foundation's
  `CompositionInputs` (brief, category, scope, signals, baseline ids, pinned snapshots,
  open critical gaps). Every answer and decision records a `decision` change event with
  `intake_id`, `gap_id`, `category`, `related_modules` and `signals`; a handler can
  recompute a working composition. The summary's `template.modules` are hints with
  semantic keys (`goals.outcomes`, `problem.evidence`, `constraints.solutions`,
  `security.privacy`, `integrations.third_party`, `quality.evaluation`, …); the composer
  decides and may map them to its pack's keys.
- **Blockers:** answers on blockers and third-party policy propose `constraint` entities
  with `attrs.blocker` (`type: unknown`, `limit_kind: other | policy`, severity from the
  gap), which the blockers lane's checks pick up once accepted.
- **Review and quality:** two readiness checks are registered (`intake.critical_blockers`
  hard, `intake.open_decisions` advisory); a PRD's gaps are its own and those of the
  intakes linked to it.
- **Runs (CR-07):** `runs.service` gained three Oracle knobs and reuses the intake's
  snapshot at start; `flows.PromptContext` gained `intake_id` and `intake_gap_ids`.
