# Oracle's read of an intake (INT2)

Spec: [product-oracle-v2/specs/spec-INT2.md](product-oracle-v2/specs/spec-INT2.md), as
amended by the owner's answers of 2026-10-25
([owner-answers.md](product-oracle-v2/specs/owner-answers.md), INT2). Code:
`api/oracle/intake/read.py`.

When someone starts a new PRD from a brief, Oracle runs two reads of it: the instant
**rules read** (unchanged, it always stands) and **Oracle's read**, a model reading of the
brief and the author's pinned sources that adds inferences and open gaps, marked
"Oracle's inference" and private to the author until they share them (S6).

## Where it runs

| Path | When | Cost |
|---|---|---|
| SwarmCloud run, flow `intake_analysis` (one segment `read`, role analyst, quick depth) | the default | $1.50 a read (Q4) |
| Oracle's built-in `intake_analysis` pool job ([llm-jobs.md](llm-jobs.md)) | the SwarmCloud read could not start, failed, or returned nothing usable (fallback, Q3); or `ORACLE_INTAKE_READ_RUNTIME=job` (rollback) | pool tokens |

The intake records which path produced its read (`ai_read.path`), and, for a fallback,
why (`ai_read.fallback.code`: `agent_unavailable`, `agent_failed` or `invalid_output`).

The run itself is private to its creator, the intake's author (`FlowDef.creator_only`):
`GET /v1/runs`, `GET /v1/runs/{id}` and its files (and MCP `list_runs`, `get_run`,
`get_run_artifact`) list and read it for the author, their personal tokens and MCP
clients only; any other member, an API token, or a run that reads as a member gets no row
and 404. The discussion panel's Runs screen context leaves it out.

## When it starts

- On create and on repin, when the intake's `ai_extraction` is on and the company setting
  `intake_ai_read` is on (Settings › Company, default on, owners; Q2).
- On demand: `POST /v1/intakes/{id}/ai-read` (Analyse with Oracle), the author only; 409
  while a read is under way, on a converted or archived intake, or with the switch off.
  At most 3 a Company day per intake (owner decision 2026-10-26; `oracle.company_time`,
  the Company time zone; the reads on create and repin are not counted, and owners get the
  same cap): the fourth is 429, "This intake was read 3 times today; read it again
  tomorrow". The author's `ai_read` carries `reads_today`, `reads_per_day` and, at the
  cap, that sentence as `read_again_refused`; the intake page shows "(2 of 3 today)"
  before Read again, and at the cap disables it with the sentence.
- At the tick, for intakes whose queued job migration `0055_intake_read` cancelled
  (`moved_to_swarmcloud`): at most 20 a tick.

One read at a time: a newer read ends the one under way (the newest snapshot wins).

## What the run reads

Exactly the job's payload (`oracle.intake.job.payload`), through one run-bound route
(Q1): `GET /v1/intakes/{id}/analysis-input` (`get_intake_analysis_input`). Only the token
of that intake's own `intake_analysis` run may call it: the run's flow is
`intake_analysis`, its `read_intake_id` knob names the intake, its creator is the intake's
author, its snapshot is the intake's latest, and its token holds `read:intake-input`
(minted for that segment only). Any other run token gets 404; people, API tokens and MCP
clients get 403 "This is for Oracle's read of an intake"; an ended run's token 401. Each
read is audited (`intake.evidence_query`, route `get_intake_analysis_input`, spec-INT2).

What leaves Oracle: the brief and up to 25 excerpts of the author's pinned sources, which
now also pass through the company's SwarmCloud tenant; its step logs and artifacts hold
`analysis.yaml`. The run token is revoked when the run ends.

## What it writes

`analysis.yaml`: `version: 1`, `items` (`field`, `text`, `evidence_refs`), `gaps`
(`category`, `statement`, `importance`, `evidence_refs`), `category`. The importer
(`intake_analysis`) stores it through `oracle.intake.job.apply_answer`, with the job's
caps, dedupe and S6 restriction; refs outside the payload are dropped and counted. A read
that finishes after the intake closed imports nothing ("Skipped: the intake is …").

## What the author sees

`IntakeSummary.ai_read` (null for anyone but the author): `state` (`off`, `queued`,
`running`, `done`, `failed`), `path`, `run_id` or `job_id`, `started_at`, `finished_at`,
`sources`, `added` (`items`, `gaps`), `dropped_refs`, `error`, `fallback`, `note`,
`failures`, and `off_reason` (`company` or `intake`). After two failed reads in a row (the
fallback job failing too) the author gets one Inbox row (`InboxOut.intake_reads`), which
ends on a successful read or when the intake closes.

## Rollback

- Without a deploy: `ORACLE_INTAKE_READ_RUNTIME=job` (in `oracle.config`), for a wide
  SwarmCloud outage or while caller MCP is off for the tenant.
- Full revert: revert the change. The migration's downgrade refuses while an
  `intake_analysis` run has not ended or a live token holds `read:intake-input`. Back up
  the database first.
