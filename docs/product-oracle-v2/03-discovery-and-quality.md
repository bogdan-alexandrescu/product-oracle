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
| 6. Short batches, every path | `engine.ask_batch`, `answers.answer` | Batches of five (1-10), asked by the author or an approver. Each question offers `answer`, `dont_know`, `defer`, `delegate` (to a company member who can answer) and `research`. A delegated question can be answered only by the person asked or an approver. A gap decided by an explicit decision (validated, accepted risk) is never rewritten by a later `dont_know`, `defer`, `research` or `delegate`. |
| 7. Proposals, never approvals | `answers._propose_baseline`, `_propose_patch`, `propose_research` | An answer proposes a baseline entity (outcome, constraint with `attrs.blocker`, risk or decision) in the baseline's proposals; a `decision` change event through `oracle/changes.py` for the modules lane; a `prd_patch` when the intake is linked to a PRD (accepting it opens a feedback item on the latest version, refused on an approved section); a `research_run` for "Research this" and for "I don't know" on a critical gap. |
| 8. The review gate | `oracle/intake/checks.py` | `intake.critical_blockers` (hard) is critical while a critical blockers or third-party-policy gap of the PRD is unresolved; `intake.open_decisions` (advisory) warns on other critical gaps. Only an owner clears a critical gap without review (B4): an answer below the owner role moves it to `answered_pending_review` (still unresolved); validating it unanswered, validating a critical hard blocker, accepting its risk or assumption, lowering its importance, or moving an intake with an open critical blocker off its PRD all take an owner. An approver may validate an answered critical gap that is not a hard blocker. |

All seventeen categories are covered: customer/user, pain evidence, company-goal
alignment, success metric and baseline, differentiation, alternatives, current and future
constraints, blockers, economic benefit, effort and cost, security and privacy, team
ownership, non-goals, release and rollout, evaluation criteria, third-party policy and API
limits, configurability and scaling (`categories.CATEGORIES`).

## 2. The snapshot lock (CR-12, S4)

- An intake pins a snapshot at creation (`snapshots`, as of the database clock) or one the
  author picks; `product_intakes.source_snapshot_ids` keeps every pin, and the last is the
  one it reads. "Version N" is the Nth pin.
- Pin stability: a version is stamped when it is written, not when its transaction
  commits, so `as_of` alone would let a sync that began before the pin and committed after
  it join the pinned set. A snapshot also records the database's transaction snapshot
  (`snapshots.txn_snapshot`), each version its writing transaction
  (`source_item_versions.xid`) and each deletion its transaction
  (`source_items.deleted_xid`). A pinned read keeps only what had committed when the pin
  was taken (`sources.items.version_at_pin`, `deleted_at_pin`). Rows from before the
  migration have no xid and count as committed.
- Every read goes through `oracle.sources.items.items_as_of`, so later syncs do not reach
  the analysis. Re-analysis on the same pin gives the same gaps.
- `GET /v1/intakes/{id}/new-evidence` lists the author's items added, changed or deleted
  since the pinned version: the "new evidence since version X" shown before a redraft. An
  item created and deleted after the pin is not listed (it was never seen). Only the
  author sees the items or their number.
- `POST /v1/intakes/{id}/repin` and `/analyze` (the author only: both re-read the
  author's sources) pin anew or re-analyse. A decided gap (answered, pending review,
  validated, accepted risk, deferred) is never touched, not even its `lock_version`; new
  evidence reaches open gaps only.
- A run started from an intake (`POST /v1/intakes/{id}/runs`, or an accepted research
  proposal) carries `intake_id`, `intake_snapshot_id` and, for research, `intake_gap_ids`
  as Oracle knobs. `runs.service.start` reads the intake's snapshot instead of taking a
  new one. The agents' prompt names the intake id and the tools to read it with, never its
  text. A run created by someone other than the intake's author (an approver) can read
  that snapshot (`GET /v1/snapshots/{id}/items` allows a snapshot a run of the caller is
  pinned to); what it reads there is the run creator's own items, never the author's, and
  the intake itself only as its findings are shared (S6).
- Agent runs, including runs the author starts, read each finding only at its sharing
  level (S6 follow-up 3, owner 2026-10-19): a run token is never the author for reads.
  While any finding of an intake is below "shared in full", its author's runs read no
  item that intake's analysis or model jobs read, cited or not (owner, 2026-10-19, after
  review found the model can cite nothing); sharing every finding in full makes them
  readable again. Each intake records what it read (`analysis.read_item_ids`: the
  relevant hits and what each model job was given; reads only accumulate) and the
  withheld set is precomputed in `intake_withheld_items`
  (`oracle.intake.evidence.record_reads`, rewritten on every analysis and level change),
  so `run_withheld` is one indexed query. An intake analysed before findings or reads
  were recorded withholds everything its analysis names until it is analysed again
  (fail closed; the migration backfills existing intakes the same way). Withheld items
  are left out of `/v1/search`, `/v1/sources/{id}/items`, `/v1/snapshots/{id}/items`,
  upload results and a run's `item_count`, and are 404 at `/v1/source-items/{id}`; a run
  cannot attach one as baseline evidence (404), cite it in an answer (422), link it from
  a baseline YAML, nor read its title and link on baseline evidence.
  A model-written gap never registered as a model finding (written before S6) counts
  as private, so its intake keeps withholding. `record_reads` inserts with
  `ON CONFLICT DO NOTHING`, so two writers recomputing one intake never conflict.
- A finding shared in full makes its cited documents readable to runs in full text,
  search and read (owner, 2026-10-19, round 6), any run's user, while people see the
  title, link and 400-character excerpt; the intake rule above always wins. What the
  findings shared in full cite is precomputed in `intake_shared_items` (rewritten with
  the withheld set). For a run, `/intakes/{id}/evidence` (its author's own run and every
  other) searches the items the intake's findings shared in full cite, less what any
  intake of the author withholds (`evidence.run_include`), within the intake's chosen
  sources, filtered in SQL before ranking and the limit (so hidden items that match
  never change the answer); a hit's snippet shows only where the item itself is shown.
  `/v1/source-items/{id}` and `/v1/search` give a run the same items
  (`evidence.run_shared`), whoever owns them, and the intake summary shows a run no
  title or excerpt of a withheld item. To give agents a private source, its author
  shares every finding of its intake in full.
- Freeze at sharing (owner, 2026-10-19, round 7): sharing a finding in full releases
  exactly the (item, version) pairs it cites at that moment, each at the version the
  intake read at its pin (`analysis.findings[id].frozen`, mirrored in
  `intake_shared_items.version_id`). Items a later analysis adds, and newer versions,
  stay withheld (added to `intake_withheld_items`) until the author shares the finding
  in full again, which releases what it cites then. `FindingOut.unshared_item_ids` tells
  the author what is new since they shared. Every run route reads a shared item at its
  released version only: `/v1/source-items/{id}`, `/v1/search` (whatever `as_of` says),
  `/intakes/{id}/evidence`, the summary's refs and baseline evidence a run attaches;
  people see the released version's excerpt too. An item deleted upstream is no longer
  readable or searchable by runs nor shown to people. If two releases of one item
  differ, the sources routes serve the newest released version, an intake's own
  routes the version that intake released.
- Lowering stays consistent (round 7): a re-analysis brings open baseline proposals
  down to their finding's level as setting the level does (private withdraws them); a
  withdrawn proposal keeps only the category's question. Deciding and withdrawing take
  the proposal row `FOR UPDATE`, so an accept and a withdraw never both win
  (`baseline.proposal.withdrawn`, `baseline.proposal.withdraw_skipped` audited).

## 3. Untrusted content

- Source text is data. In the API it only appears as `data_excerpt` on an `EvidenceRef`
  with `untrusted: true`, to the item's owner (never through a run token), or to anyone
  when the author shared a finding citing it in full (S6, below).
- The `intake_analysis` job's system prompt is the fixed file
  `api/oracle/jobs/prompts/intake_analysis.v2.md`. Outside `untrusted_data` the user
  message carries only Oracle's own fixed values: the intake id, fields, category keys and
  labels, existing gaps as `ref`, category and status, the closed categories and the
  limits. Everything people or sources wrote travels inside `untrusted_data`: the title,
  the brief, every gap statement (any commenter can write one), the confirmed goals and
  the excerpts. The answer is validated: known fields and categories, text cut to 500
  characters, at most 12 items and 8 gaps per run (40 and 24 per intake), evidence refs
  that resolve to items the job was given, no gap in a category already answered or
  covered by the baseline, no gap that says what an existing gap of its category says
  (normalised content words). Results are AI inferences and open gaps only; the job can
  neither answer nor close anything, and adds nothing to a converted or archived intake.
- Runs get the intake id, not its text. Run tokens read intakes, gaps, questions and
  answers with `read:baseline`; the routes that can return source titles, links or
  excerpts (`/intakes/{id}/summary`, `/question-batch`, `/evidence`, `/new-evidence`) need
  `read:sources`; run tokens can never answer, decide, accept or share.
- Every evidence search is audited (`intake.evidence_query`: query, hits, item ids, pin),
  and so is every read that returns titles, links or excerpts (`intake.evidence_read`:
  route and item ids).

## 3b. What others see of the author's findings (S6)

The owner decided on 2026-10-19 (S6) that the author chooses, per finding, what others
see of a finding drawn from their own sources (`oracle/intake/sharing.py`):

| Level | Others see |
|---|---|
| `private` (default) | nothing: the finding is left out, a model-written gap is 404 with its questions, answers and decisions, a rule-made gap shows no evidence, confidence or inferred state |
| `counts` | `shared_counts` on the summary and `analysis`: kind, category and number ("1 conflict in success metric and baseline evidence") |
| `summary` | one line per finding: Oracle drafts it and the author confirms or edits it (`PUT /v1/intakes/{id}/findings/{finding_id}/summary`, audited as `intake.finding_summary_set` without the text); until then others see only Oracle's fixed category line ("Oracle found an open question about release and rollout in the author's sources."). No filter publishes model text. Evidence refs without titles, links or excerpts; conflicts without values |
| `full` | everything, excerpts of the cited items included |

Findings are the model-written items and gaps, source conflicts, stale evidence, and the
evidence of a rule-made gap (the gap's fixed category text stays shared). They live in
`product_intakes.analysis.findings`, keyed by finding id, so a re-analysis keeps every
level. A finding drawn only from text everyone can read (the brief, the title) is not
restricted. Anything drawn from sources that was never registered (an intake analysed
before S6) fails closed: others see it as `private` until the author re-runs the
analysis. The author sees everything (never through a run token: a run token's calls
carry `x-oracle-run-id`, which only narrows); viewers, commenters, approvers, owners and
run tokens see each finding at its level in every read: the summary, the question batch,
composition inputs, proposals, the foundation's list and get routes for intakes, gaps,
questions, answers and assumption decisions, and the readiness checks (a model-written
gap the author has not shared does not count there; its rule-made category gap does).
`PATCH /v1/intakes/{id}/findings/{finding_id}` and `POST /v1/intakes/{id}/findings/sharing`
(bulk) set levels, the author only, each change audited (`intake.finding_shared`: from,
to); the author can lower a level at any time. Text that travels into shared places
(baseline proposals, PRD patches, research proposals, coverage reasons) never carries a
model-written gap's own words.

`private` means others see nothing, including that a finding exists. So what the
author's sources say about a rule-made gap (its evidence, confidence and inferred state)
is kept in the gap's finding (`evidence_ids`, `confidence`, `state`), never on the shared
gap row: the author's reads (and anyone's, at `summary` or above) add it back. A repin
that changes only what private sources say moves no shared row, not even a
`lock_version` or `updated_at`, and a draft question's stored rationale is the one
everyone reads. Gap importance comes from the brief and public facts only:
`knowledge_gaps.importance_basis` records where it came from, `brief` (the engine sets it
from the brief and refreshes it on each analysis while the gap is open) or `person`
(someone set it, `PATCH /v1/gaps/{id}` or `POST /v1/gaps`; kept). Recording it changes the
same rows whether or not the intake holds a private finding for the gap. Only a
rule-made row from before the basis was recorded (NULL) is read from the brief, or from
the importance edit its finding recorded then; `/v1/gaps?importance=`, next actions,
composition inputs and the B4 checks all read that same public importance.

Three more follow-ups (owner, 2026-10-19):

- A critical gap from private sources blocks publishing only once its author shares it
  at `counts` or above; it is then named in the gate by its id and category alone. While
  it is private, publish passes, and the author alone is warned: the readiness check
  adds "Only you see this: ..." (status `warning`) when the report is read by the author
  (`ReadinessContext.viewer`, ignored for `purpose="publish"`, whose report is stored
  with the gate), and the summary's `readiness.private_blocking_gap_ids` lists them for
  the author.
- Answering a question about a private finding makes no baseline proposal (nothing in
  the baseline names the gap or the intake). When the author shares the finding at
  `counts`, each answer is proposed once with its category's question only; from
  `summary` up the answer and severity appear (§ Blockers below). Lowering the finding
  back to private withdraws its open proposal (status `withdrawn`: never listed by
  `/v1/baseline/proposals`, 404 to accept or reject); sharing it again makes a new one;
  an accepted or rejected proposal stays as decided (owner, 2026-10-19, round 6).
- Setting a level or summary on a finding drawn from shared text only (not restricted)
  is a 409. The audit of a summary line set on a private finding, and of a level
  lowered to private, records no kind or category.
- Agent runs read each finding at its level (§2 above).

## 4. Routes (all `/v1`, all MCP tools)

| Route | Tool | Role | Screen |
|---|---|---|---|
| `POST /intakes` | `create_intake` | commenter | New product idea |
| `PATCH /intakes/{item_id}` | `update_intake` | commenter (author) or approver; linking a PRD: approver | New product idea |
| `GET /intakes/{intake_id}/summary` | `get_intake_summary` | viewer | Opportunity and Gaps |
| `POST /intakes/{intake_id}/analyze` | `analyze_intake` | the author | Opportunity and Gaps |
| `GET /intakes/{intake_id}/new-evidence` | `get_intake_new_evidence` | viewer (items for the author only) | Opportunity and Gaps |
| `POST /intakes/{intake_id}/repin` | `repin_intake` | the author | Opportunity and Gaps |
| `GET /intakes/{intake_id}/findings` | `list_intake_findings` | viewer | Sharing panel |
| `PATCH /intakes/{intake_id}/findings/{finding_id}` | `set_intake_finding_sharing` | the author | Sharing panel |
| `POST /intakes/{intake_id}/findings/sharing` | `set_intake_findings_sharing` | the author | Sharing panel |
| `PUT /intakes/{intake_id}/findings/{finding_id}/summary` | `set_intake_finding_summary` | the author (never a run) | Sharing panel |
| `GET /intakes/{intake_id}/evidence?q=` | `search_intake_evidence` | viewer (own items; a run: items findings shared in full cite, less withheld) | Evidence panel |
| `GET /intakes/{intake_id}/question-batch` | `get_question_batch` | viewer | Question batch |
| `POST /intakes/{intake_id}/question-batches` | `ask_next_question_batch` | the author or an approver | Question batch |
| `GET /intakes/{intake_id}/composition-inputs` | `get_intake_composition_inputs` | viewer | (modules lane) |
| `POST /intakes/{intake_id}/runs` | `start_intake_run` | approver | Opportunity and Gaps |
| `GET /intakes/{intake_id}/proposals` | `list_intake_proposals` | viewer | Proposals |
| `POST /intake-proposals/{id}/accept`, `/dismiss` | `accept_intake_proposal`, `dismiss_intake_proposal` | approver | Proposals |
| `POST /gaps`, `PATCH /gaps/{item_id}` | `create_knowledge_gap`, `update_knowledge_gap` | commenter, approver | Opportunity and Gaps |
| `POST /gaps/{gap_id}/decisions` | `decide_knowledge_gap` | approver; owner to clear a critical gap without review (B4) | Opportunity and Gaps |
| `POST /gaps/{gap_id}/research` | `propose_gap_research` | commenter | Question batch |
| `POST /questions/{question_id}/answers` | `answer_question` | commenter (the person asked, or an approver) | Question batch |

The foundation's list and get routes (`list_intakes`, `get_knowledge_gap`, …) return
the reader's view (S6) through `oracle.v2.router.register_view`. Every write is audited (`intake.*`), and another company's id is a 404.

## 5. Schema

One additive migration, `0014_intake` (down_revision `0013`, re-chained at merge):
`intake_proposals` (what an intake proposes until a person decides) and, on `llm_jobs`,
`intake_id`, a nullable `document_id`, the `intake_analysis` kind and a check that a job
has a document or an intake. The security review added, in the same revision: the gap
status `answered_pending_review` (B4), and the pin-stability columns
`snapshots.txn_snapshot`, `source_item_versions.xid` and `source_items.deleted_xid`.
Otherwise gaps, questions, answers and decisions use the foundation's tables; the chosen
sources, the analysis and the findings' sharing levels live in `product_intakes.analysis`.

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
  with `attrs.blocker` (`type: unknown`, `limit_kind: other | policy`, severity: the
  gap's public importance), which the blockers lane's checks pick up once accepted. An
  answer to a finding shared at counts proposes only its category's fixed question
  (`attrs`: the gap's id and category; no answer text, no severity); from summary up the
  same open proposal carries the answer and severity, and lowering the level to counts
  strips them again (owner, 2026-10-19). A question-only proposal is never accepted
  (409: it waits for the author to share the answer); once it is decided, the answer
  is proposed as a follow-up from summary up. A stale finding at summary shows its line
  without the item's confidence (which counts freshness). A PRD patch quotes the answer, so it is proposed, and
  accepted, only while everyone may read the gap.
- **Review and quality:** two readiness checks are registered (`intake.critical_blockers`
  hard, `intake.open_decisions` advisory); a PRD's gaps are its own and those of the
  intakes linked to it.
- **Runs (CR-07):** `runs.service` gained three Oracle knobs and reuses the intake's
  snapshot at start; `flows.PromptContext` gained `intake_id` and `intake_gap_ids`.
