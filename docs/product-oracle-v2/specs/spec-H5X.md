# H5X Experiments and HEART metrics: Oracle reads each experiment's results from the analytics source, says plainly whether there is a difference yet, and shows running experiments in the weekly metrics review

Group H (Head-of-product coverage) · Size L · Builds on H5 Metrics review (#517, on main) · Verified against this checkout's `HEAD` f972c5e (merge train Q) on 2026-10-25 · Owner questions Q-H5X-1 to Q-H5X-4 in `questions.json`; this spec is written to the recommended answers.

## Why this matters

- **For the person using Oracle.** A founder ships a change "to see if it helps" and then reads a dashboard by eye, too early, and calls the winner they hoped for. Nobody writes down the hypothesis, the one number that decides it, or how long to wait. The research lists **experiments and HEART metric design** under the head of product's measurement work (research §10.3 R11, [62]). R11 keeps choosing what defines success with people. H5 left both out on purpose: "Experiments and HEART metric design (research R11 lists them; a later pick)" (#517, Out of scope). The pick: "experiments with a written hypothesis, read from the analytics source, and HEART metrics per product area".
- **For the product.** H5 already reads PostHog every week. It flags variances and asks owners to explain them. Three gaps stay open:
  - A variance caused by a running experiment looks like noise or a launch. H5's possible causes (`api/oracle/metrics/causes.py`) know launches, changelog entries, done roadmap items and decisions, but not experiments.
  - H1 decisions and H3 predictions (`api/oracle/quality/schemas.py:162-179`) say "we expect +5% trial-to-paid". An experiment is the cheapest way to test that before a hard-to-reverse launch. Today nothing links the two.
  - Metrics are a flat list of outputs and inputs. A product area has no Happiness, Engagement, Adoption, Retention and Task-success set (Google's HEART framework), so a review cannot tell whether a launch helped adoption but hurt task success.
- **For engineering.** Almost everything exists:
  - the PostHog connection, its guarded client and HogQL query endpoint (`api/oracle/metrics/posthog.py:120-125`);
  - week bounds in the Company time zone (`pull.py:60` `fill_query`);
  - the ticker step (`pull.py:418` `pull_due`);
  - the weekly ritual and its blocks (`rituals/kinds.py:65`, `rituals/blocks.py:640-682`);
  - the `metrics_variance` explanation run (`runs/flows.py:1117-1166`);
  - decisions with predictions and H3 outcome records.

  This pick adds one experiment table with its results, one HEART field on metrics, one deterministic results rule, and one ritual block. It adds no new connector and no new paid run.

## Verified current state

| Piece | Where | State on main |
|---|---|---|
| Metric catalog | `api/oracle/metrics/models.py:40-46, 49-108` | `kind` output or input, `source` posthog, manual or api, `query` HogQL with `{period_start}`/`{period_end}`, `direction`, `goal_id`, `drives_metric_id`. No HEART category, no product area |
| Weekly values | `metrics/models.py:110-130` `metric_values` | One value per metric per Monday-start week. No breakdown by variant |
| PostHog client | `metrics/posthog.py:29, 32, 78, 120-125` | `query_number(conn, hogql)` → `POST {host}/api/projects/{project_id}/query/` with a `HogQLQuery`. It must return **one row with one number**. https only, public addresses only (`check_host`) |
| Analytics connection | `api/oracle/integrations/models.py:34, 74`; `integrations/router.py:372-425` | `company_integrations` provider `posthog`, purpose `metrics`, `config` `{host, project_id}`; key in `ciphertext`, never returned |
| Variance rule | `metrics/variance.py:22-24, 50` | median of the last 12 changes, threshold fallback 10% |
| Possible causes | `metrics/causes.py` | launches, changelog, done roadmap items, decisions, definition changes. No experiments |
| Weekly review | `rituals/kinds.py:65`; `metrics/review.py:98, 129`; `rituals/blocks.py:640-682` | `metrics_review` blocks `metrics_table, variances, goals, outcomes_due, needs_decision` |
| Explanation run | `runs/flows.py:1117-1166`; `metrics/explain.py:48, 142`; `rituals/summaries.py:48` | `metrics_variance`: one analyst at quick, $1.50, `summary.md` + `variances.yaml` |
| Occurrence screen | `web/app/company/rituals/_components/OccurrenceDetail.tsx:18-21, 46-49, 152-155`; `MetricBlocks.tsx` | `MetricsTable` and `VarianceCards` renderers |
| Metrics page | `web/app/company/metrics/page.tsx`, `_components/{MetricChart,MetricForm,MetricInspector}.tsx`, `lib.ts` | Table, inspector, Add metric |
| Company tabs | `web/app/company/_tabs.ts` | Strategy · Decisions · Rituals · Updates · Metrics · Market |
| "Experiment" today | `api/oracle/v2/models.py:121, 568` `feasibility_experiments`; `api/oracle/quality/models.py:76` `outcome_records.experiment_id` | Only **feasibility** experiments on blockers (planned to inconclusive). `grep -ri "HEART\|A/B"` over `api/`, `web/` and `docs/` finds nothing |
| Predictions | `quality/schemas.py:162-179`; `decisions/models.py:135-139` | typed `unit`, `direction`, `baseline_value`, `predicted_value`, `threshold_value`; a decision's `prediction` creates an outcome record |
| Autonomy | `api/oracle/autonomy.py:59-66, 367-389` | `rituals` (`max_run_usd`), `outcomes`. No experiment responsibility; no metrics responsibility |
| Mock | `web/lib/api/mock/metrics.ts:190, 286`; `server.ts:1718-1728` | scenario `metrics`: three made-up metrics, two variances |
| Alembic head | `api/migrations/versions/0054_reply_opened.py` | the next migration's `down_revision` is main's head at build time |

Counts: 0 product experiments, 0 HEART tags, 0 variant breakdowns. 1 analytics connection kind (PostHog).

## What to build

### Concepts (plain words, used on screen)

- **Experiment**: a change shown to some people and not others, to learn whether it moves one number. It has a **hypothesis** ("If we show the setup checklist to new teams, more of them invite a teammate in week 1, because…"), a **feature flag** in PostHog that splits people into **variants** (Control and one or two others), a **primary metric** that decides it, up to three **guardrail metrics** that must not get worse, a **planned length** in days, and an owner.
  - On screen it is "Experiment". Blocker work keeps its existing name, "Feasibility experiment". The two never share a table or a list.
- **Exposure**: a person who saw a variant. Oracle counts exposures from PostHog's `$feature_flag_called` events for the flag (see Results).
- **Result**: per variant, the exposures, the primary metric's value, the difference from Control with a 95% range, and a plain verdict:
  - **Too early**: planned length or planned sample not reached. No winner is shown, even if one variant is ahead (no peeking).
  - **No clear difference**: the 95% range of the difference includes zero.
  - **<Variant> better** or **<Variant> worse**: the range excludes zero, by the metric's good direction.
  - **Guardrail hit**: a guardrail metric is worse with its range excluding zero. This shows at any time, even while Too early.
  - **Uneven split**: the exposures differ from the planned split more than chance allows (sample ratio check, p < 0.001). The verdict is withheld until someone looks.
- **Conclusion**: what a person decides at the end: **Ship <variant>**, **Keep Control**, or **Run again**, with a reason. It becomes a decision in the decision log.
- **HEART**: five kinds of user-experience metric for one **product area** (a Plan track):
  - **Happiness**: what people say (survey score);
  - **Engagement**: how much they use it;
  - **Adoption**: new people starting to use it;
  - **Retention**: people coming back;
  - **Task success**: people finishing what they came to do, how fast, and with how many errors.

  A metric can carry one HEART category and one product area. The Metrics page and the review can group by them. People choose the metrics (R11). Oracle never picks them.

### Defining an experiment

**Company › Metrics › Experiments** (`/company/metrics?tab=experiments`, a sub-tab of Metrics; placement follows Q2 "New pages", which put Metrics on Company). **New experiment** (approvers and owners) opens a sheet:

1. **Hypothesis**: "If we… then… because…", 20 to 600 characters. Required.
2. **Feature flag key**: the PostHog flag key, for example `setup-checklist`. **Check flag** runs one HogQL query for the last 7 days' exposures by variant. It shows "Seen 1,204 times in 7 days: control 598, checklist 606", or the provider's error. Oracle never creates, edits or turns on a flag: the team does that in PostHog.
3. **Variants**: keys and labels, Control first, 2 or 3 in all, and the planned split (default even).
4. **Primary metric**, one of:
   - **Conversion**: share of exposed people who did event E within N days of first exposure (E from a picker that runs a 90-day `SELECT DISTINCT event`; N from 1 to 28, default 7);
   - **Mean per person**: average count of event E per exposed person within N days;
   - **From an H5 metric**: an existing PostHog metric whose query uses `{person_filter}` (below). Manual and API metrics are not offered: they have no per-person data.
5. **Good direction** (prefilled from the H5 metric).
6. **Guardrails**: up to 3 metrics of the same three shapes.
7. **Minimum effect worth knowing**, as a relative change, default 5%. Oracle shows the **sample per variant** and the **estimated days** from the last 4 weeks' exposure rate (two-sided, 95%, 80% power, deterministic). The planned length defaults to that estimate, rounded up to whole weeks, at least 7 and at most 56 days.
8. **Links**, all optional: the decision it tests (H1; its prediction prefills the primary metric and minimum effect); the launch it belongs to (H6); the product area (a Plan track).
9. **Owner**: a member, by default the creator.

States: **Draft** → **Running** (Start, which records `started_on`; reading begins) → **Ready to conclude** (planned length and sample reached) → **Concluded** or **Stopped** (with a reason). Running can be stopped early. Early stops are labelled "Stopped early" everywhere.

Limits: 20 running experiments per company (422 above).

### Reading results from the analytics source (deterministic, no model call)

Written to Q-H5X-1 "Experiment results", recommended: **Oracle computes results from per-variant HogQL counts with one fixed rule.** It does not call PostHog's Experiments API. This needs no new key scope beyond H5's query access, works the same for every experiment, and keeps the rule in Oracle's code, where tests pin it.

- **Ticker step.** `experiments.read_due(db)` runs in `_tick_company` (`api/oracle/ticker/router.py`) right after `metrics.pull_due`, in its own `try` and savepoint. It reads each Running experiment once a day after 06:00 Company time. At most 20 queries per company per tick, sharing H5's budget: metrics pull first.
- **Queries.** `api/oracle/experiments/queries.py` builds HogQL from the definition. No free text comes from the person, except an H5 metric's own query, which is already stored and tested.
  - Exposures: people with `$feature_flag_called` for the flag key since `started_on`, grouped by `$feature_flag_response`. A person is counted in their **first** variant. People seen in two variants are counted and shown ("12 people saw two variants"), and excluded.
  - Conversion: per variant, `count(exposed)` and `count(converted within N days of first exposure)`.
  - Mean per person: per variant, `n`, `sum`, `sum of squares` of the per-person count.
  - From an H5 metric: `{person_filter}` is replaced by the exposed set for one variant, and the query runs once per variant over the experiment's window.
  - `query_number` returns one number. The client gains `query_rows(conn, hogql, max_rows=10)` beside it (`metrics/posthog.py`). It uses the same endpoint, the same guards, and a 30 s timeout.
- **The rule** (`api/oracle/experiments/stats.py`), written to Q-H5X-2 "How results are judged", recommended: **fixed-horizon, two-sided, 95%**.
  - Conversion: difference of proportions with a normal-approximation 95% range. Mean per person: Welch range.
  - Each variant is compared with Control. With 2 non-control variants the range is widened (Bonferroni, 97.5%). The screen says so in its (i).
  - Sample ratio: chi-square against the planned split. p < 0.001 gives Uneven split.
  - The verdict follows the Concepts list. Before Ready to conclude, the only verdicts shown are Too early, Guardrail hit and Uneven split. The difference so far is shown greyed, with "Not a result yet: <n> of <planned> days".
- **Stored.** One `experiment_readings` row per experiment per day: per-variant figures and the verdict. The chart draws the daily difference with its range.
- **Failures.** As H5: `attempts` and `last_error`. After 3 failed days the experiment shows "Not read for 3 days", and its owner gets an Inbox row. Disconnecting PostHog stops reading. The experiment keeps its last reading, marked with its date.

### HEART metrics

- `metrics` gains `heart text NULL CHECK (heart IN ('happiness','engagement','adoption','retention','task_success'))` and `area_track_id uuid NULL` (a Plan track).
- The Add metric sheet (`MetricForm.tsx`) gains **HEART** (optional) and **Product area** (optional).
- **HEART view.** The Metrics page gains a **Group by: Kind · HEART** switch. In HEART mode the table groups per product area into the five rows. An empty row reads "No metric for Adoption yet". It is a prompt, not a gap Oracle fills.
- **Happiness** from PostHog surveys: the HogQL picker offers survey response events (`survey sent`) for a rating question. Written to Q-H5X-3 "Happiness data", recommended: **PostHog surveys, or values by hand**. No new survey tool.
- **Task success** often needs a start and an end event. The sheet offers a **Completion rate** helper: share of people with event A who did event B within N minutes. It writes the HogQL for the person to review and save.
- **HEART on experiments.** An experiment's guardrails default to the product area's Task success and Retention metrics when they exist, with a line saying why.

### How the weekly review shows them

`metrics_review` (`rituals/kinds.py:65`) gains a block, **after** `variances`:

```python
("metrics_table", "experiments", "variances", "goals", "outcomes_due", "needs_decision")
```

Existing occurrences keep the blocks they were built with. The new block applies from the next pre-read.

- **`experiments` block** (`metrics/review.py`, or `experiments/review.py`, registered in `rituals/blocks.py` `TITLES` and `BUILDERS`). One row per experiment Running, Ready to conclude, or concluded or stopped in the period:
  - title and hypothesis (first 140 characters);
  - day `<n>` of `<planned>`, and exposures per variant;
  - the primary metric per variant, the difference with its range, and the verdict chip (Too early · No clear difference · Checklist better · Guardrail hit · Uneven split);
  - guardrails: OK or the one that was hit;
  - the owner (name), and `href` `/company/metrics?tab=experiments&experiment=<id>`.

  Order: Guardrail hit and Uneven split first, then Ready to conclude, then Running, then concluded.
- **`metrics_table`.** In a company with any HEART-tagged metric, outputs are followed by a HEART sub-group per product area. A metric's row shows a "Running experiment" chip when an experiment's primary metric is that metric, or uses the same event.
- **Variances.** `causes.py` adds experiments **started, stopped or concluded** in the 14 days before the week's end as possible causes, ranked first when the variance's metric is the experiment's primary or a guardrail metric. The cause reads "Experiment 'Setup checklist' started Oct 14 (50% of new teams)".
- **Oracle's explanation run.** `metrics_variance` (`runs/flows.py:1117-1166`) adds tools `list_experiments` and `get_experiment`, and one task line: "When a running experiment touches the metric, say so and cite it. Never call an experiment's winner: quote its verdict." The cost stays at **$1.50**, and the run stays a single analyst step at quick.
- **Inbox rows**:

| Row | Who | Counts | Ends when |
|---|---|---|---|
| "Conclude an experiment · <title>" | the experiment's owner | yes | Concluded or Stopped |
| "Guardrail hit · <title> · <metric>" | the owner, and approvers following it | yes | opened, or the experiment is stopped |
| "Experiment not read for 3 days · <title>" | the owner | yes | a reading succeeds |

`InboxOut` gains `experiments: list[InboxExperiment]`, `{experiment_id, title, reason: "conclude"|"guardrail"|"read_failed", counts}`.

### Concluding: from experiment to decision log

- **Conclude** (the experiment's owner, approvers and owners) is offered once Ready to conclude, and on a Stopped experiment. It asks for:
  - Ship `<variant>`, Keep Control, or Run again;
  - a reason, 10 to 1,000 characters;
  - optionally a **prediction** for after the rollout, prefilled from the measured difference (H3).
- It creates a **decided** H1 decision:
  - `origin = 'experiment'`, `source_kind = 'experiment'`, `source_id` = the experiment;
  - title "Experiment: <title>", options = the three choices, the chosen one marked;
  - `context` = the hypothesis and the final reading;
  - `reversibility = reversible` (a flag can be turned off);
  - approver = the person concluding.

  When the experiment links a decision, the new one is linked to it with `supersedes_id` only if the person ticks "This settles D-<n>".
- Ship with a prediction creates an H3 outcome record. `outcome_records` gains `product_experiment_id` (FK), beside the existing `experiment_id`, which stays for feasibility experiments (`quality/models.py:76`).
- Written to Q-H5X-4 "Who concludes", recommended: **the experiment's owner, or any approver or owner**. Concluding is a person's call at every autonomy level.

### H11 Autonomy

No new responsibility. Oracle observes and reports; it never starts, stops or concludes an experiment, and never touches a flag. The review block is built at every `rituals` level but Observe (H2 rule). The Settings › Autonomy "Stays with people" list is unchanged; `STAYS_WITH_PEOPLE` (`autonomy.py:59-66`) needs no edit.

### Screens and copy

**Company › Metrics › Experiments** (`/company/metrics?tab=experiments`):
- Table: Experiment · State · Day (`12 of 28`) · Verdict chip · Primary metric · Owner · Area. Approvers and owners see **New experiment**. Others see the page as View only.
- Inspector:
  - the hypothesis;
  - the flag and variants with the planned and actual split;
  - the daily difference chart with its range band and the planned end marked (charts follow the `dataviz` skill palette, as H5's `MetricChart.tsx`);
  - per-variant table;
  - guardrails;
  - links (decision, launch, area);
  - the reading's date;
  - actions: Start, Stop (with reason), Conclude, Edit (Draft only; after Start only the owner, guardrails and links change), Read now (approver).
- Words: "Too early: day 9 of 28. Checklist is ahead so far, but this is not a result yet." · "No clear difference: the range (−1.2% to +3.4%) includes zero." · "Guardrail hit: Weekly retained teams is worse for Checklist (−4.1%, range −6.9% to −1.3%)."

**Metrics page:** Group by Kind · HEART; HEART and Product area in the sheet and inspector.

**Occurrence page:** `MetricBlocks.tsx` gains `ExperimentRows`, added to `OccurrenceDetail.tsx`'s renderers (`:152-155`) and `WIDE` set (`:21`).

Phone: the table collapses to Experiment and Verdict, and the inspector opens as a sheet. Every date is in the Company time zone, labelled. Every person is shown by name.

### API

```
GET    /v1/experiments?state=                   -> [ExperimentOut]       (list_experiments, viewer)
POST   /v1/experiments         ExperimentCreate -> 201 ExperimentOut     (create_experiment, approver)
GET    /v1/experiments/{id}                     -> ExperimentDetail      (get_experiment, viewer: readings, verdict history)
PATCH  /v1/experiments/{id}    ExperimentPatch  -> ExperimentOut         (owner of it or approver; lock_version; definition frozen after start)
POST   /v1/experiments/{id}/start               -> ExperimentOut         (owner of it or approver; 409 unless draft; 409 when PostHog is not connected)
POST   /v1/experiments/{id}/stop   {reason}     -> ExperimentOut
POST   /v1/experiments/{id}/read                -> ExperimentOut         (approver; 502 with the provider's message)
POST   /v1/experiments/{id}/conclude {choice, variant?, reason, prediction?} -> 201 DecisionOut
POST   /v1/experiments/check-flag {flag_key}    -> FlagCheckOut          (approver; nothing stored)
POST   /v1/experiments/plan {baseline, min_effect_pct, variants, flag_key?} -> PlanOut  (sample and days; viewer)
```

`MetricCreate`/`MetricPatch`/`MetricOut` gain `heart` and `area_track_id`.

```jsonc
// ExperimentOut
{ "id": "…", "title": "Setup checklist for new teams", "hypothesis": "If we…",
  "flag_key": "setup-checklist", "variants": [{"key": "control", "label": "Control", "split": 50},
  {"key": "checklist", "label": "Checklist", "split": 50}],
  "primary": {"shape": "conversion", "event": "teammate invited", "window_days": 7, "direction": "up"},
  "guardrails": [{"metric_id": "…", "title": "Weekly retained teams"}],
  "state": "running", "started_on": "2026-10-14", "planned_days": 28, "planned_per_variant": 1800,
  "verdict": "too_early", "reading": {"on": "2026-10-24", "variants": [
    {"key": "control", "exposed": 902, "value": 0.211}, {"key": "checklist", "exposed": 915, "value": 0.236,
     "diff_pct": 11.8, "range": [-3.1, 26.7]}]},
  "owner_name": "<member name>", "decision_number": null, "lock_version": 3 }
```

Errors: 403 role; 404 other company's ids; 409 stale `lock_version`, start without PostHog, conclude before Ready (unless Stopped); 422 hypothesis length, 1 or 4+ variants, splits not summing to 100, more than 3 guardrails, N outside 1-28, a primary H5 metric without `{person_filter}` or not PostHog, more than 20 running.

### Data model and migration

Migration `00NN_experiments`: its number and `down_revision` are main's single alembic head at build time (`uv run alembic heads`; `0054_reply_opened` today).

```sql
CREATE TABLE product_experiments (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL, hypothesis text NOT NULL CHECK (length(hypothesis) BETWEEN 20 AND 600),
  flag_key text NOT NULL, variants jsonb NOT NULL, primary_def jsonb NOT NULL,
  guardrails jsonb NOT NULL DEFAULT '[]', min_effect_pct numeric(6,2) NOT NULL DEFAULT 5,
  planned_days integer NOT NULL CHECK (planned_days BETWEEN 7 AND 56), planned_per_variant integer,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','running','ready','concluded','stopped')),
  started_on date, ended_on date, stop_reason text,
  owner_id uuid NOT NULL, decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  conclusion_decision_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  launch_id uuid REFERENCES launches(id) ON DELETE SET NULL, area_track_id uuid,
  attempts integer NOT NULL DEFAULT 0, last_error text, last_read_at timestamptz,
  created_by uuid, lock_version integer NOT NULL DEFAULT 1
);
CREATE TABLE experiment_readings (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  experiment_id uuid NOT NULL REFERENCES product_experiments(id) ON DELETE CASCADE,
  read_on date NOT NULL, variants jsonb NOT NULL, guardrails jsonb NOT NULL DEFAULT '[]',
  srm_p numeric, verdict text NOT NULL, UNIQUE (experiment_id, read_on)
);
ALTER TABLE metrics ADD COLUMN heart text CHECK (heart IS NULL OR heart IN
  ('happiness','engagement','adoption','retention','task_success'));
ALTER TABLE metrics ADD COLUMN area_track_id uuid;
ALTER TABLE outcome_records ADD COLUMN product_experiment_id uuid REFERENCES product_experiments(id) ON DELETE SET NULL;
```

Through `oracle.migration_checks.add_check_values`: `decisions.origin` gains `experiment` (`decisions/models.py:35`). `CAPTURED_ORIGINS` (`:51`) gains `experiment`, since the decision is decided at capture. Downgrade drops both tables and the three columns, and removes the CHECK value when no decision uses it.

### MCP and agents

- `READ_AREAS["read:baseline"]` (`api/oracle/mcp/scopes.py`) gains `experiments`.
- `flows.MCP_TOOLS` gains `list_experiments` ("product experiments with their hypothesis, state and latest verdict") and `get_experiment`.
- `metrics_variance` and `update_draft` add both tools. The update's task line "Metrics first…" gains "then experiments concluded in the period, with their verdict".
- Agents never write experiments or readings: no write scope.

### Files

| File | Change |
|---|---|
| `api/oracle/experiments/{__init__,models,schemas,service,router,queries,stats,read,review,conclude}.py` | new package |
| `api/oracle/metrics/posthog.py` | `query_rows` beside `query_number` |
| `api/oracle/metrics/models.py`, `schemas.py`, `service.py` | `heart`, `area_track_id` |
| `api/oracle/metrics/causes.py`, `metrics/review.py` | experiments as causes; HEART grouping in `metrics_table` |
| `api/oracle/rituals/kinds.py:65`, `rituals/blocks.py:55-56, 640-682` | `experiments` block |
| `api/oracle/runs/flows.py:1117-1166` (`metrics_variance`), `:784-831` (`update_draft`), `MCP_TOOLS` | tools and task lines |
| `api/oracle/ticker/router.py` | `experiments.read_due` after `metrics.pull_due` |
| `api/oracle/decisions/models.py:35, 51`; `api/oracle/quality/models.py:76` | `experiment` origin; `product_experiment_id` |
| `api/oracle/runs/schemas.py` (`InboxOut`), `metrics/review.py:202` pattern | Inbox rows |
| `api/oracle/mcp/scopes.py`, `api/oracle/capabilities.py` | read area; per-item rule (experiment owner) |
| `api/migrations/versions/00NN_experiments.py` | tables, columns, CHECK |
| `web/app/company/metrics/page.tsx`, `_components/{ExperimentTable,ExperimentInspector,ExperimentForm}.tsx`, `MetricForm.tsx`, `MetricInspector.tsx` | Experiments sub-tab, HEART fields and grouping |
| `web/app/company/rituals/_components/MetricBlocks.tsx`, `OccurrenceDetail.tsx:18-21, 152-155` | `ExperimentRows` |
| `web/app/inbox/_needs.tsx` | experiment rows |
| `web/lib/api/mock/experiments.ts`, `web/lib/api/mock/server.ts` | scenario `experiments`: made-up flag `setup-checklist`, made-up readings |
| `api/tests/test_experiments.py`, `test_experiments_stats.py`, `test_experiments_read.py`, `test_metrics_heart.py`, `web/e2e/experiments.spec.ts` | tests |

## Out of scope / do not touch

- Creating, changing or rolling out feature flags in PostHog. Oracle only reads.
- PostHog's Experiments API and its Bayesian results (Q-H5X-1, not recommended).
- Sequential testing, CUPED, multi-armed bandits, and more than three variants.
- Analytics sources other than PostHog (H5 Q1).
- Choosing which metrics define success or which HEART metrics a product area has (R11, human-owned).
- Feasibility experiments (`v2/models.py:568`): unchanged.
- Any model call during reading or results.

## Acceptance criteria

1. `stats.compare` on synthetic counts:
   - control 1000/200 and variant 1000/260 gives a range excluding zero and **better** (direction up);
   - 1000/200 and 1000/205 gives **No clear difference**;
   - with planned days not reached, the verdict is `too_early` whatever the counts;
   - a guardrail worse with its range excluding zero gives `guardrail_hit` on day 3;
   - an 1000/1300 split planned 50/50 gives `uneven_split`.
2. `plan` with baseline 20%, minimum effect 10% relative and 2 variants returns the per-variant sample to within 1% of the textbook value, and days from a stubbed 4-week exposure rate.
3. `read_due` with a fake PostHog stores one reading per day. A second tick the same day queries nothing. 3 failed days create one Inbox row for the owner. A person seen in two variants is excluded and counted.
4. `queries.py` never interpolates person text: a flag key with a quote or semicolon is refused 422 (`^[A-Za-z0-9_-]{1,100}$`). Event names are passed as HogQL string literals with escaping, as a unit test pins.
5. Conclude: before Ready → 409; Ship with a prediction creates a decided decision with origin `experiment` and an outcome record with `product_experiment_id`; a commenter → 403; a repeat returns the same decision.
6. The `metrics_review` pre-read built after this change has an `experiments` block ordered Guardrail hit, Ready, Running. An occurrence built before it renders unchanged.
7. `causes.py` lists an experiment started 5 days before the week's end first for a variance on its primary metric.
8. A metric with `heart: "adoption"` and an area track groups under that area's Adoption row. 422 for an unknown HEART value.
9. Every route returns 404 for another company's ids. Run tokens read `list_experiments` and get 403 on every write.
10. Playwright, mock layer (`web/e2e/experiments.spec.ts`, scenario `experiments`, made-up flags and numbers, Company zone America/Los_Angeles):
    a. An approver opens Company › Metrics › Experiments, clicks New experiment, writes a hypothesis, types the flag key, clicks Check flag and sees per-variant exposures, picks a conversion metric, sees the sample and days, saves and clicks Start.
    b. A running experiment on day 9 of 28 shows "Too early" and no winner. The same experiment on day 28 shows "Checklist better" with its range.
    c. The owner clicks Conclude, picks Ship Checklist, writes a reason and lands on the decided decision in Company › Decisions.
    d. The weekly review occurrence shows the Experiments block with the guardrail-hit row first.
    e. On Metrics, Group by HEART shows the area's five rows with "No metric for Happiness yet".
    f. A viewer sees no New experiment, Start or Conclude (absent, not disabled).
    g. At 390 px the experiments table has no horizontal scroll.
11. Each test states its card: `protects=…; fails_when=…; no_claim=…`.
12. Existing suites pass unchanged: `api/tests/test_metrics*.py`, `test_rituals*.py`, `test_decisions*.py`, `test_outcomes*.py`, `web/e2e/metrics.spec.ts`, `web/e2e/rituals.spec.ts`.

## Testing plan

| Layer | What | Count |
|---|---|---|
| Unit | stats (ranges, verdicts, SRM, Bonferroni), plan, HogQL builders and escaping | +16 |
| API | CRUD, states, conclude, HEART fields, isolation, run-token reads | +14 |
| Integration | ticker reading with fake PostHog, review block, causes, `metrics_variance` tools (fake runtime) | +6 |
| Migration | up and down | +2 |
| E2E (Playwright, mock) | criteria 10a-10g | +7 |

## Rules for the implementing agent

1. Acceptance criteria are the `protects / fails_when / no_claim` profile of each test: the observable it protects, the wrong result it rejects, and what green does not prove. Never "make the tests pass".
2. Real code and real tests land in the same change; a placeholder, a stub assertion or a test deferred to a follow-up is not done.
3. Any change to a test, validator, CI step, timeout, tolerance, threshold, snapshot or suppression pragma is reported on its own line in your summary with its justification, before any other result.
4. A reported command names the command and its observed result (exit status, counts, the failing line); a command you did not run is not reported, and stderr is never silenced in a command you cite.
5. Your report is a claim until the parent re-executes it: say what you verified, what you reused, and what you could not check.
6. Before building, check PostHog's `$feature_flag_called` event, `$feature_flag_response` property and query row limits against PostHog's docs. This spec assumes them.

## Rollback

Revert the PR. The ticker step is one call in its own `try`; reverting stops all reading without touching metrics pulls. The downgrade drops `experiment_readings`, `product_experiments`, `metrics.heart`, `metrics.area_track_id` and `outcome_records.product_experiment_id`. Decisions with origin `experiment` stay as ordinary decided decisions. Remove the CHECK value only when none exists, else keep it. Occurrences built with an `experiments` block render it as an unknown block (skipped). Back up the database first (V2a); the image migrates itself, so never migrate first.

## Dependencies

- **Built on (on main):**
  - H5 Metrics review (connection, client, ticker, review, explanation run);
  - H1 Decision log;
  - H3 Predicted versus actual;
  - H6 Launches;
  - H2 Cadence engine;
  - Plan tracks (product areas).
- **Changes:** H5's `metrics_review` blocks, `metrics_variance` tools, `metrics_table` grouping; H8's `update_draft` tools.
- **Unblocks:**
  - H3 can judge a decision's prediction against a measured experiment instead of a before/after goal value;
  - H6 tier-1 launches can carry "launch behind an experiment" as a checklist task (a follow-up, not here);
  - H9 Pricing input's research plan can cite price experiments once PostHog flags carry prices (H9 keeps price experiments out of scope today);
  - G7 Head-of-product panel and F6 Weekly alignment can cite experiments through MCP with no change of their own.

## Size and lanes

L, about 9 days in three lanes. Lanes 2 and 3 start once lane 1's schemas merge.

| Lane | Scope | Effort |
|---|---|---|
| 1. Engine | models, migration, HogQL builders, `query_rows`, stats and plan, ticker reading, conclude to decision and outcome, HEART fields, API, MCP scopes | 4 d |
| 2. Review | `experiments` block, `metrics_table` HEART grouping, causes, `metrics_variance` and `update_draft` tools, Inbox rows | 1.5 d |
| 3. UI | Experiments sub-tab (table, inspector, sheet, chart), HEART fields and Group by, occurrence renderer, Inbox rows, mock scenario, Playwright | 3.5 d |

## Open questions for the owner

In `questions.json`; this spec is written to each recommended answer.
- **Q-H5X-1 "Experiment results"**: Oracle computes from per-variant HogQL counts (recommended), reads PostHog's own Experiments results, or results are typed by hand.
- **Q-H5X-2 "How results are judged"**: fixed-horizon 95% with no early winners (recommended), Bayesian chance-to-beat-control, or both shown.
- **Q-H5X-3 "Happiness data"**: PostHog surveys or values by hand (recommended), a separate survey tool connector, or leave Happiness out.
- **Q-H5X-4 "Who concludes"**: the experiment's owner or any approver or owner (recommended), owners only, or the owner of the linked decision.

Defaults taken from recorded decisions, not asked:
- PostHog is the analytics source (H5 Q1, answered 2026-10-23).
- Experiments sit under Company › Metrics (Q2 "New pages", answered 2026-10-23).
- Which metrics define success stays with people (research R11; `STAYS_WITH_PEOPLE`).
