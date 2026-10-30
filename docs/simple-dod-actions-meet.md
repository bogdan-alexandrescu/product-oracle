# Simple Definition of Done, item 4: meetings, decisions and chat

Every action below is proven by a mock-backed Playwright spec that drives the UI (web/e2e,
`test` from e2e/test.ts, the mock clock), on desktop and on a phone (390x844). Each cell is
`spec file › test name`. Older specs run desktop at 1366x820; this lane's new `dod-meet-*`
specs at 1440x900. `(phone)` / `(desktop)` is the test's own suffix or its describe block.

## Start a review meeting

| Action | Role | Desktop | Phone |
|---|---|---|---|
| Start a review (sheet, attendees, Start) | owner | simple-meetings-start › desktop · light › the Meetings page lists upcoming, live and past; an owner starts a review | simple-meetings-start › phone · light › same test |
| Start from a scheduled review, a one-pager, the roadmap | owner | simple-meetings-start › desktop › a scheduled review, a one-pager and the roadmap open the start sheet | simple-meetings-start › phone › same test |
| Start a review | the PRD's decider (owns nothing) | simple-meetings-start › the PRD's decider › Dana Decider starts Guided setup's review; an approver may not (desktop) | same test (phone) |
| Start refused, with who may | approver / commenter / viewer | simple-meetings-start › desktop › {an approver, a commenter, a viewer} sees who starts a review and cannot start it | simple-meetings-start › phone › same tests |
| Join a live meeting | commenter | simple-meetings-start › desktop › a commenter joins a live meeting an owner started | simple-meetings-start › phone › same test |
| Guided steps (1 One-pager, 2 Roadmap, 3 Decisions), full screen, the clock | owner | simple-meeting-screen › desktop › the three steps, the clock and the chat column | simple-meeting-screen › phone › same test |

## Meeting decisions (recorded as a decision with who and when)

| Action | Role | Desktop | Phone |
|---|---|---|---|
| Approve, Move, Cut, a line edit: each a row with who and when; a comment with who and when | owner | dod-meet-meeting › desktop › approve, move and cut in a meeting are decisions with who and when; a comment too (desktop) | dod-meet-meeting › phone › same test (phone) |
| Cut on a draft item reads Cut with Restore | owner | dod-meet-meeting › desktop › a draft item cut in the meeting reads Cut with Restore (desktop) | dod-meet-meeting › phone › same test (phone) |
| Accept a pending proposal; comment is the meeting's comment | owner | simple-meeting-screen › desktop › changes, an accepted proposal and a comment become the meeting's decisions | simple-meeting-screen › phone › same test |
| Cut asks first, Restore | owner | qa2-simple-meetings › desktop · the live meeting › one main, one rules control, … End asks first | qa3-simple-meetings-review › phone › phone: the meeting's buttons and chips are 44 px tall |
| No Approve, End, presence or change-mode control | commenter | simple-meeting-screen › desktop › approve with an absent reviewer waits on them; a commenter has no controls | simple-meeting-screen › phone › same test |
| No Start, End or rules control | viewer | qa2-simple-meetings › desktop › a viewer gets no Start review, no End meeting and no rules control | qa2-simple-meetings › phone › same test |
| The owner's Approve, a required reviewer absent: waits on them | owner | simple-meeting-screen › desktop › approve with an absent reviewer waits on them; … | simple-meeting-screen › phone › same test |
| The decider's Approve is the working draft's approval | the PRD's decider | dod-meet-meeting › the PRD's decider › the decider's Approve in the meeting is the working draft's approval (desktop) | same test (phone) |
| Approve with no required reviewer publishes; with one, waits | owner | simple-meetings-approve › desktop › Approve on a PRD with no required reviewer publishes: … | simple-meetings-approve › phone › same tests |

## Change by chat in the meeting

| Action | Role | Desktop | Phone |
|---|---|---|---|
| A card applies only on an allowed person's Apply; it becomes a meeting decision | presenter / approver | simple-chat › desktop › two attendees share the thread; only the presenter applies; the applied card is a decision (desktop) | simple-chat › phone › same test (phone) |
| An ambiguous request gets one question, no card | owner | simple-chat › desktop › a viewer asks only; an ambiguous request gets one question (desktop) | simple-chat › phone › same test (phone) |
| A viewer's change request gets a note, no card | viewer | simple-chat › desktop › a viewer asks only; … (desktop) | simple-chat › phone › same test (phone) |
| Notes, agenda, owner and decider from the meeting chat | owner / approver / viewer | simple-chat-actions › desktop › (six tests) | simple-chat-actions › phone › same tests |

## The presenter's change mode

| Mode | Desktop | Phone |
|---|---|---|
| Everyone (except viewers): a non-decider's button proposes | simple-chat › desktop › the presenter's change mode decides who may apply (desktop) | simple-chat › phone › same test (phone) |
| Only the presenter: others' Apply and Discard disabled, "Only the presenter applies changes in this meeting" | simple-chat › desktop › two attendees share the thread; … (desktop); simple-meeting-screen › desktop › the presenter lets only named people change things | simple-chat › phone › same tests |
| Presenter plus one or two named people: the others' "Only the presenter and the people they named apply changes in this meeting" | simple-chat › desktop › the presenter's change mode decides who may apply (desktop); simple-meeting-screen › desktop › the presenter lets only named people change things | simple-chat › phone › same tests |

## Change by chat in Simple's Ask panel, on every Simple page

| Action | Role | Desktop | Phone |
|---|---|---|---|
| Home, One-pagers, PRDs, a PRD, Roadmap, Priorities, Decisions, Meetings: the card applies | owner | dod-meet-ask › desktop › an owner's Ask card on every Simple page says Apply and does it (desktop) | dod-meet-ask › phone › same test (phone) |
| The same pages: the card proposes | commenter | dod-meet-ask › desktop › a commenter's Ask card on every Simple page says Propose and does it (desktop) | dod-meet-ask › phone › same test (phone) |
| Preview, Reject, Apply, Undo on the roadmap | owner | simple-ask-changes › desktop › the owner previews, discards, applies and undoes from the Ask panel (desktop) | simple-ask-changes › phone › same test (phone) |
| A viewer's card disabled with why | viewer | simple-ask-changes › desktop, dark › a viewer's cards are disabled with why; … | Not run on a phone: the same card and the same reason render in the phone's sheet, which dod-meet-ask drives for the other roles |

## End meeting

| Action | Desktop | Phone |
|---|---|---|
| Oracle writes the minutes and the decision log; edit; Send to Decisions page and Inbox | simple-meeting-end › desktop · light › the minutes are edited and sent to the Decisions page and the Inbox only | simple-meeting-end › phone · light › same test |
| Whoever ends picks email | simple-meeting-end › desktop › the attendees are emailed when chosen | simple-meeting-end › phone › same test |
| Whoever ends picks Slack (connected) | simple-meeting-end › Slack connected › minutes are posted to the notifications channel (desktop) | same test (phone) |
| Email not set up: it cannot be picked | simple-meeting-end › email not set up › email cannot be chosen; dod-meet-minutes › email cannot be picked when it is not set up (desktop) | dod-meet-minutes › email cannot be picked when it is not set up (phone) |
| Failed or slow minutes job | simple-meetings-walk › desktop › a failed minutes job: … / a slow minutes job: … | simple-meetings-walk › phone › same tests |

## The minutes on the Decisions page and in the Inbox

| Action | Desktop | Phone |
|---|---|---|
| By meeting: the minutes and their decisions | simple-meeting-end › desktop · light › the minutes are edited and sent …; dod-meet-minutes › desktop › the minutes read on the Decisions page's List and By meeting (desktop) | same tests (phone) |
| List: the minutes beside the meeting's decisions | dod-meet-minutes › desktop › the minutes read on the Decisions page's List and By meeting (desktop) | same test (phone) |
| Board | Not a place for the minutes, by the design as built: the Board holds the PRDs' open questions (Needs input, Recommended, Decided); dod-meet-minutes checks the Board draws no meeting group | same |
| Linked from each item they changed (a roadmap item, a one-pager line) | simple-decisions-page › desktop · light › a roadmap item and a one-pager line link to the decisions that changed them | simple-decisions-page › phone · light › same test |
| In each attendee's Inbox, Open leads to the minutes | dod-meet-minutes › desktop › an attendee's Inbox has the minutes; Open reads them on the Decisions page (desktop) | same test (phone) |

## Bugs the new specs found

- The Inbox never drew a meeting's minutes: the API (and the mock) send `simple_minutes`, the
  Inbox page had no row for them. Fixed: a "Meeting minutes" row (shown, not counted), Open
  goes to the Decisions page by that meeting.
- A Cut on a draft roadmap item (the mock's "Team invite nudges", not confirmed yet) was
  recorded as a decision, but the item still read "draft" (the API's and the mock's status
  put the draft before the cut), so the meeting kept it in its horizon with Cut. Fixed: a cut
  draft reads cut, with Restore; Undo makes it a draft again (API:
  test_simple_additions_api.py › test_a_cut_draft_item_reads_cut; UI: dod-meet-meeting › a
  draft item cut in the meeting reads Cut with Restore, desktop and phone).

No cell is MISSING. Two cells say why they are as they are: the viewer's Ask card on a phone
(the same card and reason, the phone's sheet proven for the other roles) and the Board (it
holds questions, not minutes, as designed).
