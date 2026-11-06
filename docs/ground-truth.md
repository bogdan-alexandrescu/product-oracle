# The Ground Truth

The owner approved this definition on Nov 5, 2026, to be kept once and for all. Every page,
run and rule reads the Ground Truth this way. The rule that points here is in
`.claude/rules/oracle-product.md`.

## What it is

The Ground Truth is the company's one cited record of what the product is for and what it
is made of:

- **Goals**: each with its measure, target and date, and its guardrails.
- **Features**: each with its F-code and name (F-15 Usage export), the goal it serves, what
  it depends on, its effort and its mark (New, In progress or Exists).
- **Requirements**, **constraints** and **decisions**.
- **Every link between them** (a feature serves a goal, depends on a feature, meets a
  requirement, ...).

Each entry and each link carries its source: the document, chat, task or person it came
from.

## Who changes it

- People edit it in the UI. A delete goes to Trash, from where it can be restored.
- Runs only propose changes. An approver confirms or rejects each one. Until then a run's
  entry is a proposal, not part of the Ground Truth.
- Only confirmed features are in the Ground Truth (the owner, Nov 5). A roadmap item linked
  to a feature a run proposed but no approver confirmed is flagged **Not in the Ground
  Truth**, with the fixes **Confirm it** and **Link to a feature**.

## Running today

"Running today" is Detailed's second tab. It lists the features that run now, each with its
proof: code map hits, merged pull requests, done tasks or a measured value. Oracle reads the
proof again every night.

It gives each feature its mark:

- **New**: nothing of it runs today.
- **In progress**: work on it is under way.
- **Exists**: it runs today, with proof.

## PRDs

- A PRD's goals and features are Ground Truth entries, named by their code.
- A new feature a PRD proposes joins the Ground Truth, and gets its F-code, when the PRD is
  approved.

## Roadmaps

- Every roadmap item is a Ground Truth feature or a slice of one (F-15a, F-15b: one slice per
  milestone the feature spans).
- Its goal, what it depends on, its effort and its mark come from the Ground Truth.
- Its dates come from its date sources or from Oracle's estimate.
- A feature that runs today leaves the roadmap.

## Breaking the rules: flag it, don't refuse

The owner's pick: anything that breaks these rules is **allowed but flagged**. A save is
never refused for it.

A flagged item shows as **Not in the Ground Truth**, with the fixes **Add to Ground Truth**
and **Link to a feature** (**Confirm it** and **Link to a feature** when its feature is only
proposed), or the one fix its kind needs. Home and the Ground Truth page
count the flags, and each count leads to the flagged items.

The Ground Truth check lists every flag. Its six kinds, and the fixes each offers (the
check's `action`, with the button's words):

| Kind | What it means | Fixes |
| --- | --- | --- |
| `unlinked_item` | A roadmap item linked to no feature | Add to Ground Truth (`add_to_ground_truth`), Link to a feature (`link_to_feature`) |
| `unlinked_item` | A roadmap item linked to a feature a run proposed but no approver confirmed | Confirm it (`confirm_feature`), Link to a feature (`link_to_feature`) |
| `slice_parent_missing` | A slice (F-15a) whose feature is not in the Ground Truth | Add to Ground Truth, Link to a feature |
| `prd_feature_missing` | A feature of a PRD's approved version that is not in the Ground Truth | Add to Ground Truth, Link to a feature |
| `no_code` | A Ground Truth feature with no F-code | Give it a code (`give_code`) |
| `no_goal` | A Ground Truth feature that serves no goal | Pick a goal (`pick_goal`) |
| `runs_today_on_roadmap` | A feature that runs today but is still on the roadmap | Take it off the roadmap (`take_off_roadmap`) |

Each flag says what is wrong in one short plain sentence, with no ids; each fix carries its
button's words.

**Add to Ground Truth** makes the feature with its link in one change: for a roadmap item
the feature lists the item's key (`attrs.roadmap_items`, which stays across versions, so a
published item is linked too); for a PRD's feature or slice it keeps the PRD's code (F-09)
and serves the goal the PRD gives it. Approvers and owners add at once; a commenter's add is
a proposal carrying the same link, and the flag clears once an approver accepts it (the
owner, Nov 5). **Link to a feature** adds the item's key to the chosen feature the same way.

"The roadmap" here is what every reader is shown: the shown version of the company roadmap
(each company-visible roadmap while there is no company roadmap), without cut, shipped,
merged or taken-off items, or the items of a replaced PRD. A PRD's features are those of
the plan read from its approved version.

## Internal names that keep "baseline"

People read "Ground Truth". The code keeps its older name, "baseline", in these places;
they are not renamed:

- **API routes**: `/v1/baseline/*`, including the check, `GET /v1/baseline/check`
  (`get_check`, schema `GroundTruthOut`). Readable by anyone who can read the roadmap (viewer and
  up), in the caller's company only.
- **Code**: the `oracle.baseline` package (the check is `oracle/baseline/check.py`), the web
  route `web/app/baseline` and the mock `web/lib/api/mock/baseline.ts`; the check's mock is
  `web/lib/api/mock/ground-truth.ts` (scenario `ground-truth-flags`).
- **Tables**: `entities`, `edges`, `evidence`, `proposals`, `conflicts`,
  `entity_revisions`, `goal_measurements`; Running today's `feature_states` and
  `feature_proofs`.
- **Enums and kinds**: the run flow `baseline_to_prd`; the ritual kind `baseline_rebuild`;
  the checkpoint kind `baseline_confirm`; the run artifact key `baseline_import`; the intake
  field `reuse_baseline`.
- **Scopes**: the run token scope `read:baseline`.
