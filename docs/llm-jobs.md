# Built-in model jobs

Review comments, reporting and refinement run in Product Oracle itself (questions C1c,
the owner, 2026-10-17), on the company's Claude account pool
([claude-accounts.md](claude-accounts.md)). Every call goes through
`oracle.llm.complete()`; agent workflows stay in SwarmCloud. Code: `api/oracle/jobs/`.

## Jobs

`llm_jobs` (migration 0008): kind (`review_comments | reporting | refinement`), the
document, version and section, status (`queued | running | succeeded | failed |
cancelled`), input, output, the account that ran it (label, or `via` the fallback
credential), model, tokens and cost when Claude reports them, attempts, error, and, when
no Claude account could take the call, the pool's reason and next reset.

- **Who queues them.** A new comment or a non-approving section verdict queues review
  comments for that version (one queued job collects every new item); importing a version
  after the first queues its reports; an approver's "Refine section" queues a
  refinement. Approvers can also queue review comments or reports by hand.
- **Who runs them.** `oracle tick` (`POST /v1/internal/tick`, which now reports a "Built-in
  jobs" line) and a local background worker in the API process
  (`ORACLE_LLM_JOBS_WORKER_SECONDS`, default 5; `0` turns it off). One job at a time per
  document: a job is claimed under the document's row lock and only when none of that
  document's jobs is running. At most `ORACLE_LLM_JOBS_MAX_PER_TICK` (10) jobs per company
  per round.
- **Failures.** A transient failure (Claude unreachable, every account it tried out of
  quota, an answer that is not the JSON asked for) goes back to the queue once, then
  fails. No Claude account available fails at once with the pool's reason
  (`no_accounts_registered`, `pool_paused`, `no_account_available` with the next reset,
  `no_recent_reading`, `unusable`); the Jobs panel says what to do. A job left running by
  a stopped worker for `ORACLE_LLM_JOBS_STALE_AFTER_SECONDS` (30 min) is reclaimed the same
  way. Retry (failed or cancelled) and Cancel (queued or running; a running job's answer is
  dropped) are approver actions.
- **Per document.** An owner turns each kind on or off (`PUT
  /v1/documents/{doc}/llm-jobs/settings`, `documents.disabled_llm_jobs`); all on by default.

## Review comments

For every open feedback item without a live suggestion, one call:

- **classifies** it: question, change request, factual correction, approval, other;
- **groups** duplicates: they share a group, and later ones point at the first
  (`duplicate_of`), so they are resolved with it;
- **drafts a suggested resolution**: the complete proposed section body (change
  requests, corrections), an answer (questions), or nothing to change;
- **pushes back once** (C1b) when the feedback contradicts a confirmed goal or
  high-confidence evidence (confidence 0.7 and up): the reason and the goals and evidence
  it conflicts with. A pushback without at least one of the sources the model was given is
  dropped, and an item Oracle pushed back on before is never pushed back on again.

Suggestions (`llm_suggestions`) appear on the feedback item (`FeedbackItemOut.suggestion`).
Nothing changes the document. An approver accepts, edits or dismisses:

- accepting an **answer** posts it as a reply in the comment thread and closes the item;
  accepting "nothing to change" closes it; accepting a **duplicate** supersedes it;
- accepted **section text** waits for a refinement;
- accepting over a **pushback** ("Keep my call") needs a reason, logged as
  `suggestion.override` for later review; "Take the advice" dismisses the suggestion and
  declines the feedback with Oracle's reasoning.

## Reporting

Per version, one call writes, from the stored facts:

- a **resolution report**: every item raised on earlier versions, its outcome, and one
  plain sentence on how it was handled or why not;
- **what changed since version N** (default the previous version): the sections added,
  removed or changed, each with a sentence, and the evidence added to the baseline between
  the two imports.

`GET /v1/documents/{doc}/versions/{n}/reports`, exportable with the version as markdown or
HTML (`.../reports/export?format=md|html`).

## Refinement

From the accepted suggestions on one section and/or an approver's instruction, one call
revises that section only. The answer is held to the house rules before anyone sees it:
the section id and level are kept, the heading loses any `{#id}`, and the body loses
citation markers, links and URLs (O1c: sources go to Sources and data points) and any
level 1-3 heading (it would open a section); headline numbers stay (O1e). Data points the
revision relies on are appended to the Sources and data points section (when the
document has one and it is not locked).

The approver sees a word diff (`GET /v1/llm-jobs/{id}/preview`), may edit the body, and
accepts (`POST /v1/llm-jobs/{id}/apply`): Oracle rebuilds the draft from the version's
stored sections (every other section byte-for-byte, so approved sections keep their
hash), adds the resolutions to its front matter and imports it as the next version
through the normal importer. Locked (approved) sections are never changed: a review
suggestion for one becomes "nothing to change", and refining one is refused, as is
accepting a refinement once a newer version exists.

## Intake analysis

`intake_analysis` (v2 lane `v2-intake`, migration `0014_intake`) runs light extraction
for a product intake: it reads the brief and the author's pinned source items, and adds
model inferences (users, outcomes, scope, ...) and open gaps to the intake. An intake has
no document, so these jobs carry `intake_id` instead of `document_id`, run one at a time
per intake, and are turned off per intake (`ai_extraction: false` on `POST
/v1/intakes`). The brief and the source excerpts reach the model only as
`untrusted_data`; what comes back is validated and labelled an AI inference. See
[product-oracle-v2/03-discovery-and-quality.md](product-oracle-v2/03-discovery-and-quality.md).

## Prompts

`api/oracle/jobs/prompts/<kind>.v<N>.md`, one system prompt per kind, versioned by file
name; each job records the prompt it ran with (`input.prompt`). The user message is the
JSON payload `oracle.jobs.kinds` builds; the answer is one JSON object.

## UI

The document page and the version's review panel have a **Jobs** panel (status, account,
cost and tokens, the failure and what to do, Retry and Cancel, and the per-document
switches). Feedback items carry **suggestion cards** (Accept, Edit, Dismiss; Take the
advice / Keep my call on a pushback). A version has a **Reports** tab (resolution report,
what changed, export). Approvers get **Refine section** on every unlocked section of the
latest version.
