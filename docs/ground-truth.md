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

"Running today" is the Running today tab in Detailed. It lists the features that run now, each with its
proof: code map hits, merged pull requests, done tasks or a measured value. Oracle reads the
proof again every night.

It gives each feature its mark:

- **New**: nothing of it runs today.
- **In progress**: work on it is under way.
- **Exists**: it runs today, with proof.

## PRDs

- A PRD's goals and features are Ground Truth entries, named by their code. A PRD's feature
  matches a Ground Truth feature by its code only, never by its name.
- A new feature a PRD proposes joins the Ground Truth, and gets its F-code, when the PRD is
  approved.
- Add to Ground Truth makes the feature with its code as its key when no feature has it: the
  PRD's F-09 is F-09, a slice's feature is F-15 (so every slice of it, F-15a and F-15b, is in the
  Ground Truth by that code at once), and an item's own code (F-02, F-09 for an item F-09a). It
  also links what was flagged (the roadmap item, or the PRD's feature). A new feature serves no
  goal yet, so it is flagged `no_goal` until one is picked.
- A feature that joins the Ground Truth (confirmed, or its PRD approved) is keyed by its own
  code: its Code attribute, else its roadmap item's or PRD feature's code, when no other
  feature has it; else by the next number. The key it had stays an alias of it and is never
  given again. A slice keeps its letter (F-15a): it has no code of its own.
- A code key (F-09, a slice F-15a) is a feature's only, stored the one way it is read (F-9 and
  F-009 are F-09; a slice keeps its letter), and once: the API refuses a new feature keyed by a
  code another feature has, whether by its key, through its published roadmap item's PRD
  section (a feature on the section f-40 reads F-40), or as a code it was given and gave back
  ("Another feature already has the code F-09.").

## Roadmaps

- Every roadmap item is a Ground Truth feature or a slice of one (F-15a, F-15b: one slice per
  milestone the feature spans).
- An item matches by code too: an item linked to no feature whose own code (F-02) or whose
  slice's feature (F-15, for F-15a) is a Ground Truth feature's code is in the Ground Truth
  and is not flagged. A feature a run only proposed does not count, so its items are flagged.
- A slice's code: its section's (F-15b), else the next letter no other slice of that feature
  has (an item of a PRD feature over several milestones, after an F-15b item: F-15c).
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

The Ground Truth check lists every flag. Its seven kinds, and the fixes each offers (the
check's `action`, with the button's words):

| Kind | What it means | Fixes |
| --- | --- | --- |
| `unlinked_item` | A roadmap item linked to no feature, whose code (or slice's feature's code) no Ground Truth feature has, and whose PRD feature is linked to none (Link to a feature) | Add to Ground Truth (`add_to_ground_truth`), Link to a feature (`link_to_feature`) |
| `unlinked_item` | A roadmap item linked to a feature a run proposed but no approver confirmed | Confirm it (`confirm_feature`), Link to a feature (`link_to_feature`) |
| `slice_parent_missing` | A roadmap slice item (F-15a, or an item of a PRD feature over several milestones) linked to no feature, whose feature (F-15) is not in the Ground Truth | Add to Ground Truth (adds F-15), Link to a feature (links the item) |
| `prd_feature_missing` | A feature of a PRD's approved version whose code no Ground Truth feature has, or that has no code | Add to Ground Truth, Link to a feature |
| `no_code` | A Ground Truth feature with no F-code | Give it a code (`give_code`) |
| `code_differs` | A Ground Truth feature keyed by the next number as it joined while its own code (its Code attribute, else its roadmap item's or PRD feature's) is another; a slice is never flagged. Shown as **Code differs from its PRD** | Use its code (`use_code`: its own code becomes its key, the old number stays an alias, never given again); when that is its roadmap item's code and another feature has it, Link to a feature (`link_to_feature`) on that item instead |
| `no_goal` | A Ground Truth feature that serves no confirmed goal by a confirmed link (a run's proposed goal or link does not count) | Pick a goal (`pick_goal`) |
| `runs_today_on_roadmap` | A feature that runs today but is still on the roadmap | Take it off the roadmap (`take_off_roadmap`) |

Each flag says what is wrong in one short plain sentence, with no ids; each fix carries its
button's words.

**Add to Ground Truth** is one change. For a roadmap item it makes the feature and sets the
item's own feature (`feature_id`) through a `set_feature` change in the roadmap's working
draft, as every roadmap edit, so a published item's link rides the next version; the check
reads an item's feature as that draft has it. For a PRD's feature or slice it keeps the
PRD's code (F-09) and serves the goal the PRD gives it. Approvers and owners add at once (the
item's link applies when they decide the roadmap, else it goes to its decider); a
commenter's add is one proposal carrying the goal and the item, and accepting it writes both
(the owner, Nov 5). **Link to a feature** is the same `set_feature` change.

- One missing feature is one flag of its own: a PRD feature over two milestones is one
  `prd_feature_missing`, never also a `slice_parent_missing` per milestone. A roadmap slice
  item of a feature the PRD flags already is an `unlinked_item`, with its slice code (F-15a).
- A code is read one way, as an F-code with two digits at least: "f-1", "F-001" and the
  number 1 are F-01, in a PRD's plan and an item's section alike; a negative or malformed
  number (-3, 3.5) is no code.
- An item of a feature that runs today is flagged `runs_today_on_roadmap` whether it is
  linked to that feature or matches it by code (F-03, or the slice F-03a).
- A PRD's feature with the name of a Ground Truth feature but another code is still flagged,
  with the hint "Same name as F-05 Bulk import." and that feature to link to.
- An item can carry two flags: `unlinked_item` and `runs_today_on_roadmap` both flag an item
  linked to a proposed feature that runs today.
- Entries in Trash are left out: an item linked to a feature in Trash reads as linked to none.
- A PRD's feature linked to a Ground Truth feature (Link to a feature) is that feature: it is
  not flagged, nor are its roadmap items (F-15, its slices F-15a). A slice given a code reads
  its feature's with a letter (F-15a), and counts as in the Ground Truth by that code.

"The roadmap" here is what every reader is shown: the shown version of the company roadmap
(each company-visible roadmap while there is no company roadmap), without cut, shipped,
merged or taken-off items, or the items of a replaced PRD. A PRD's flags show on one roadmap:
the company roadmap first, else the first by title. A PRD's features are those of
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
