# Launches and changelog (H6)

Shipping is necessary, not sufficient. When a roadmap item ships, Oracle prompts the people
who own it to pick how big the launch is, prepare support and sales, write the changelog
and tell the people who asked. Oracle drafts; people check, send and decide. Code in
`api/oracle/launches/`, the ship-signal rule in `api/oracle/roadmap/shipped.py`, migration
`0020_launches`; screens at **Roadmap › Launches** (`/roadmap/launches`) and **Roadmap ›
Changelog** (`/roadmap/changelog`) until the Plan screen hosts them as tabs.

## Lifecycle

```
planned --(every matched tracker issue done, or every milestone with the item done)--> ready
ready --(a person: Mark launched)--> launched     planned/ready --(a person: Cancel)--> cancelled
```

- **Planned.** Approving a roadmap version plans one launch per item in Now, owned by the
  approver; approving it again plans none. An approver can plan one by hand from one or
  more items of the track's latest approved roadmap (`POST /v1/launches`).
- **Ready.** The scheduled ticker's hourly step reads the ship signals
  (`shipped_items(db, track_id)`: every tracker record matched to the item is `done`, at the
  latest `observed_at`; or every milestone listing the item is `done`). The launch's owner
  gets a counted Inbox row "Ready to launch · <item>", and the launch kit run starts.
- **Launched** is always a person's action (approver and above). It records `launched_at`,
  sends the `launch` ship signal for each item to whoever registered for it (H3 Predicted
  versus actual), starts the kit run unless it ran at Ready, and lists the requesters.
  Open tasks block nothing: the dialog lists them, and a Tier 1 launch whose pre-mortem is
  still to do says so.

## Tier

Oracle suggests a tier from the innovation × goal matrix; an approver sets it.

| | Serves a top goal | Another goal or none |
|---|---|---|
| New feature | Tier 1 | Tier 2 |
| Improvement | Tier 2 | Tier 3 |
| Fix or internal | Tier 3 | Tier 3 |

A top goal is a confirmed goal with the highest weight; a feature serves it through a
confirmed `supports` edge. A feature is new when it was created for this PRD (or the PRD
uses the PR/FAQ template), an improvement otherwise; an item with no feature and no
requirements, or a feature marked `internal`, is a fix. Until a person sets the tier the
launch shows "Tier 1 suggested" with the reason in words, and approvers get a counted
"Set tier" row.

## Checklist

Built in per tier (people add tasks, or skip one with a reason): changelog entry, release
notes, internal announcement, support notes, sales and success briefing, help docs update,
in-app message, customer email, positioning check, demo, pre-mortem and notes to the
people who asked. Tier 1 has all 12; Tier 2 drops the briefing, positioning check, demo and
pre-mortem (in-app message and customer email optional); Tier 3 keeps the changelog entry,
support notes and notes. A tier change adds what is missing and removes only untouched
`todo` tasks. Task states: `todo`, `drafted` (Oracle's text attached), `done`, `skipped`.

## The launch kit run

One agent run per launch (`launch_kit`, one writer step at quick depth: $3.00). It reads the
launch, its items' PRD sections, the baseline and the requesters' own words, never other
source text, and writes `launch.yaml` (changelog entries, task drafts, a pre-mortem, one
personal note per requester). Oracle validates it (`api/oracle/launches/kit.py`): a valid
file moves the named tasks to `drafted` and adds draft changelog entries; an invalid one
changes nothing and shows its error on the launch. External drafts carry "Draft by Oracle.
A person checks and sends it." The run is not offered in the New run dialog.

## Changelog

Entries are newest first, dated and grouped as Added, Changed, Deprecated, Removed, Fixed,
Security. Internal entries are for every member. Public entries need an approver's
Publish; Oracle never publishes one. Internal entries of a launch publish themselves at
Mark launched only when the company lets Oracle act within limits on launches (setting
`autonomy`: `{"launches": "act_within_limits"}`). Public entries leave Oracle as an export a
person posts: `GET /v1/changelog/export?audience=public&format=md|html&since=`.

## Notes to the people who asked

Requesters come from requests (once C1 ships), from members whose PRD comments were
addressed on the item's section, and from people added by hand on the launch. Oracle never
looks contact details up. A person copies an external note, sends it and clicks Mark sent
(email, Slack, call or other, and the date), or skips it with a reason. Notify members puts
a shown-only "Shipped: <item>" row, carrying the note, in each member's Inbox. The launch's
owner has a counted "Notes to send · <launch> · N" row until every note is sent or skipped.

## Run tokens

Run tokens read launches, their tasks and the changelog (`read:baseline`); a launch's notes
need `read:sources`. They never publish, mark sent or mark launched.
