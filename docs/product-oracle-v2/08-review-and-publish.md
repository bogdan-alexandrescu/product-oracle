# 08 — Review correctness and immutable publish (CR-06)

Lane `v2-review`, wave 1 (API and logic only, I3). Build prompt §9 (not the Head of
Product chat), §16 items 1, 10, 11 (gate half), 12 (review routes) and 17. It extends
`oracle/review/` and `oracle/docs/`; there is no second editor and no second approval
system. Migration `0014_review` (down_revision `0013`; the integrator re-chains it).

## What a section's revision is

Versions stay immutable (`document_versions`, `sections`). A section's **revision**
(`sections.revision`, `SectionOut.revision`) covers its text (`content_hash`, over level,
heading and body), the citation entries it cites (ref, title, excerpt, source and
`retrieved_at` in UTC, in citing order) and its brief-layer membership (`oracle.docs.parser.section_revision`). So changing the
evidence behind a section, or moving it in or out of the brief, is a new revision: it
invalidates the section's approval and records a `document_section` change. A detail
section that cites nothing keeps its content hash as its revision (legacy
`content_hash` values are unchanged). A revision appears in one version and in every
later version that kept the section unchanged. `0014_review` backfills the revision of
existing sections and moves verdicts given on a content hash to the revision.

A verdict binds to the **review revision** it was given on
(`section_reviews.section_hash`, set since 0013; for older verdicts, the revision of the
section in the verdict's version): the section's revision plus its section links (kind,
target, precision, claim; the version's links and those of every version,
`oracle.review.state.review_revision`). Links are written after a version is imported,
so they are read at gate time: a link added or changed after an approval leaves the
approval stale. Edits, patches and verdict conflicts still compare `revision`.

An approval counts only while its approver still is one, read at gate time
(`oracle.review.state.standing`): an active user with the approver role or above today,
or an active user-less API token with that role (a token acting for a user approves as
the user). A demoted or disabled member's approvals, and a revoked token's or MCP OAuth
grant's, are left out of the section states, the mandatory reviewers' approvals and the
publish check.

**They lapse for good (C2).** A demotion below approver, a disable, and a token or grant
revocation mark the approvals they end as lapsed in their own transaction
(`oracle.review.state.lapse_approvals`, audited `approval.lapse`): section approvals get
`section_reviews.lapsed_at` and `lapse_reason`; a version approval moves to
`document_versions.approval_lapsed_at`, `approval_lapsed_by` and `approval_lapse_reason`
(`approved_at` and `approved_by` are cleared, so exports, `VersionOut.approved_at` and
the document's status stop saying approved; `approved_token_id` is kept) and is appended
to `document_versions.approval_lapses`, which a new approval never clears
(`VersionOut.approval_lapses`; the legacy per-version view shows a lapsed section
approval with `lapsed_at` and `lapse_reason`). Re-review is
requested where the policy asks for it, as an edit does. A re-promotion or a restore
never revives them: the approver approves again. Owner to approver is not a lapse.
Objections (changes requested, rejected) never lapse.

**Approvals name their token.** A verdict or version approval given through an API token
records it (`section_reviews.token_id`, `document_versions.approved_token_id`), also when
the token acts for a user, and every audit event records the actor's token
(`audit_events.actor_token_id`). Owners list the company's tokens (`GET /v1/api-tokens`),
see the approvals a token gave (`GET /v1/api-tokens/{id}/approvals`, lapsed ones with
`lapsed_at`) and revoke it (`DELETE /v1/api-tokens/{id}`, audited `api_token.revoke`):
the approvals it gave lapse, the approvals its user gave in person stand. A token revoked
any other way voids its approvals at gate time too.

**And their MCP OAuth grant (C2, owner 2026-10-19).** A call with an MCP client's OAuth
access token carries its grant (the refresh-token family, `oauth_tokens.family_id`):
verdicts, version approvals and audit events record it (`section_reviews.grant_id`,
`document_versions.approved_grant_id`, `audit_events.actor_grant_id`). Revoking the grant
(`POST /oauth/revoke` with either token), a reused refresh token and a replayed code end
the whole family and, in the same transaction under the review gate, lapse the
approvals made through it; a grant revoked any other way voids them at gate time.

Known limit: approvals made through a user-bound API token before `0014_member_disable`
have no `token_id` (the column did not exist): they read as the user's own approvals, so
revoking that token cannot void them. Revoking the user's approver role (or disabling
them) does.

**Removing a member disables them (C2).** `POST /v1/members/{id}/disable` (owner;
`DELETE /v1/members/{id}` is kept as the same operation, deprecated) sets
`users.disabled_at` and `disabled_by`; the row stays, so every `*_by` reference and the
verdict history keep the name. Sign-in is refused on every path
(`oracle.auth.service.may_sign_in`): the session cookie (also one minted earlier;
and since a disable and a restore set `users.sessions_valid_after`, a cookie signed
before the last of them stays dead after a restore: the member signs in fresh, and an
OAuth authorization code issued before it is refused),
password login, IAP (a disabled email is refused and never provisioned again), API
tokens and MCP OAuth tokens acting for them, an OAuth code or refresh exchange, the MCP
verifiers and a run token or run-token header of a run they started. In the same
transaction, under the review gate: each connection is disconnected (a
`connection.disconnect` audit, a `connection_revoked` revocation for the sources it
synced, the credential deleted); every other source of theirs gets a `source_revoked`
revocation, so documents citing it cannot publish; all their sources are paused (a sync
already running never un-pauses one); their API tokens and OAuth grants are revoked;
their unfinished runs are cancelled with their run tokens; the open invite for their
email and every open invite they created are revoked; the built-in model jobs they
queued are cancelled; a spend approval they gave on someone else's run that has not
started is voided (the run waits for an approval again; a started run keeps its
ceiling); their approvals lapse. No network call is made under the gate: the revokes at
the providers and the cancels at the runtime are `member_follow_ups`, made after the
disable commits (each with a deadline), recorded (`connection.provider_revoke`,
`run.runtime_cancel`) and retried by the tick (`POST /v1/internal/tick`,
`member_follow_ups`) until they succeed or five attempts fail. After the commit the
member is swept once more: a credential a request in flight created meanwhile is
revoked. A provider connection is saved, and an OAuth refresh or code exchange issues
tokens, only after the member's row is locked and re-read, so none is created for them
while the disable runs. Audited `member.disable`, change event
`member_disabled`. The last active owner cannot be disabled or demoted (a disabled owner
is not another owner). `POST /v1/members/{id}/restore` (owner, audited
`member.restore`, change event `member_restored`) lets them sign in again with their
role; nothing else comes back (approvals stay lapsed, tokens revoked, connections gone,
sources revoked). A disabled member cannot be the designated decider, a mandatory
reviewer, a section owner or reviewer, or a campaign invitee, and gets no notifications.
A disabled row never blocks the same email's password sign-in in another company.

A role change (`PATCH /v1/members/{id}`) records a `member` change event
(`role_changed`). Role changes, disables, restores and token revocations take the review
gate exclusively; a verdict and a version approval take it shared before the document
lock and re-read the caller's role, disabled state and token, so neither lands after a
change that ended it. Every member-management and invite route does the same: after the
gate (invites take it shared) it re-reads the caller (`oracle.auth.service.caller_refusal`)
and refuses with 403 a caller disabled, no longer an owner, or whose API token, OAuth
grant or run token was revoked while the request waited, so an owner being disabled
cannot act with a request already in flight.

So, per stable section id (`{#id}`):

| Status | Meaning |
|---|---|
| `unreviewed` | No verdict yet. |
| `approved` | The last verdict on the current revision is an approval that was not invalidated. It holds in later versions while the text is unchanged. |
| `approval_stale` | It was approved, then the text changed (or a change invalidated the approval). It needs an approval of the current text. |
| `changes_requested`, `rejected` | The last verdict on the current revision. |
| `revised` | A change was requested on an earlier revision and the text changed since. |

`GET /v1/documents/{doc}/versions/{n}/section-states` returns, per section: revision,
the first version with that revision, status, the approval it holds (reviewer, version,
time), the invalidation, whether re-review is requested, owner, reviewers, due date,
overdue, open feedback by severity, whether it is required and whether a publish needs
its approval, the mandatory reviewers' approvals, and the assignment's `lock_version`.

The legacy per-version view is unchanged: `SectionOut.verdict`, `locked_section_keys`,
the feedback package and the `locked_section_changed` warning still read one version's
verdicts (pinned by `tests/legacy/test_legacy_locked_sections.py`). See REV-1.

## The change handler (`oracle/changes.py`)

`import_draft` records one `document_section` change per section whose revision changed
from the previous version (cause `draft_imported`, `section_edited`, `patch_accepted`
or `run_draft`; data: `section_key`, `before_hash`, `after_hash`, `version`,
`previous_version`, `version_id`). A document's first version records none.

`review.invalidate_approvals` (registered for `document_section`) invalidates the
approvals of the **previous revision of that section only**: it adds them to
`section_review_states.invalidated_review_ids` (an invalidated approval never comes
back, even if the text later returns to its old revision), requests re-review when the
policy says so (`rereview_on_change`, default on), writes the audit event
`section_approval.invalidate`, and notifies the section's owner, reviewers and the
approvers whose approvals lapsed (`rereview_requested`). Every other section keeps its
approvals. In the view of an older version, approvals given within that revision's
unbroken run of versions still show as approved.

## Optimistic concurrency

- **Section saves**: `PUT /v1/documents/{doc}/sections/{key}` with `base_version`,
  `base_revision` (the revision the editor loaded), `heading`, `body_md` and optional
  `resolutions`. The next version is the latest version with that section replaced
  (other sections byte for byte). Another section changed since: the save applies on
  top of the latest version, so people edit different sections in parallel. The same
  section changed since: **409** `ConflictResponse` (`code: section_conflict`) with
  the current heading, body and revision to merge. The document row lock serializes
  saves, so two concurrent saves of one section never both win. Approvers edit any
  section; a section's owner edits their own. **A save stays inside its section**: the
  composed draft is parsed again and refused (422) unless it has the same section keys
  in the same order and only that section changed, so a body cannot add sections,
  rewrite another one or swallow later ones (a heading, a setext underline, an unclosed
  code fence), and a heading is one line. A section owner's `resolutions` close only
  that section's feedback (403 otherwise; closing other feedback takes the approver
  role). `feedback.resolve` audit events name the real actor.
- **Imports** (`POST /v1/documents/{doc}/versions?base_version=N`, the MCP
  `import_version` tool's `base_version`, the curated `push_draft` tool's required
  `base_version`, `oracle push`): stored as `document_versions.base_number`; `0` means
  the draft creates the document (409 if it exists). When N is older than the latest
  version, every section that changed between N and the latest must already be in the
  draft as the latest has it, and so must the front matter (outside `resolutions`) if it
  changed; otherwise **409** (`code: version_conflict`, `front_matter_changed`) naming
  both versions and the sections. An unknown base is a 422 (`unknown_base_version`).
  `oracle push` sends the version `oracle pull` wrote the file from (its
  `<slug>-v<N>.feedback-package.json` beside it) unless `--base` is given. A REST
  import without a base still works as before; the version carries the note
  `base_version_missing` (`VersionOut.notes`, not `warnings`, so legacy output is
  unchanged).
- **Verdicts**: `SectionReviewIn.revision` (optional). When the latest version has
  another revision of the section, the verdict is a 409 `section_conflict`: nobody
  approves text that changed under them. Without it, verdicts work as before.
- **Rows edited in place** carry `lock_version` (`version_id_col`): section
  assignments, review policies, campaigns and section patches. A stale value is a 409
  `ConflictResponse` with `code: stale_lock_version` and `current_lock_version`.

## AI text is a reviewable patch first

- An agent's draft never replaces an **approved** section: the imported version keeps
  the approved text and level and the agent's text waits as a `section_patches` row
  (warning `approved_section_held`, notification `patch_proposed` to the decider, owner
  and reviewers). A removed or renamed approved section is kept in place too, with a
  patch of `action: "remove"` (accepting it drops the section). The approved sections'
  citation entries are kept (the draft's front matter cannot redefine them) and so is
  their brief membership. Unapproved sections take the draft's text as before. A body
  that leaves a code fence open is closed before the next section when the held draft is
  composed (trailing whitespace-only or blank lines in the fence ignored), every draft
  composed from sections is checked to keep every section key in order (422
  `section_lost` otherwise, nothing imported), and the held draft is checked like a section edit: every approved section
  must be there with its approved revision, or the import is refused (422
  `approved_section_not_held`).
- An agent's draft closes feedback (front-matter `resolutions`) only as `addressed`, and
  only on a section whose revision the new version changes. It never declines an item,
  never closes a document-level item and never closes one on a section it left alone
  (a held approved section included); those resolutions are skipped, the items stay open
  and the version carries the warning `resolution_not_applied`.
- What is an agent's draft: a run's import (`origin="run"`), and **any REST write made
  for a run**: the MCP server's call for a run token carries the creator's session and
  the run token (`x-oracle-run-token`); REST checks the token is active, of the
  company, and of a run the session's user started (401 otherwise), and sets
  `Principal.run_id`, so `import_version`, `push_draft` and section saves made by an
  agent import with `origin="run"` and cause `run_draft`.
- `GET /v1/section-patches/{id}` shows the word diff against the current text;
  `POST .../accept` (with the reviewer's optional edit, `base_revision` and
  `lock_version`) saves it as the next version with cause `patch_accepted`, which
  invalidates that section's approval; `POST .../reject` closes it. Accepting runs
  under the document's row lock, so `applied_version` is the version it creates.
- Oracle's refinement job keeps its preview-and-apply flow; applying refuses (422) a
  composed draft that would lose any section of the base version; applying now records
  `patch_accepted` (and its `base_version`).

## Policy, owners, reviewers, campaigns, notifications

- **Review policy** (`GET/PUT /v1/documents/{doc}/review-policy`, owner; company default
  `PUT /v1/settings/review_policy`): `decider_id` (the designated decider, F2: when set,
  only they approve versions; others review sections in parallel), `mandatory_reviewer_ids`
  (no unanimity unless configured), `required_section_keys` (added to the template
  version's required sections and the composition's included required modules),
  `section_approval` (`required_sections` default, `all_sections`, `none`) and
  `rereview_on_change`. Decider and mandatory reviewers must be approvers.
- **Final approval** (`POST .../versions/{n}/approve`): the decider's when one is set
  (403 otherwise), and of the current version only (409 for a version a newer one
  replaced). Re-approval by someone else updates `approved_by` and `approved_at` (a
  version approved before a decider was set is re-approved by the decider); the same
  approver's re-approval stays idempotent. The decider and mandatory reviewers are
  matched on the user behind an API token (`token.user_id`), never the token id.
- **Owners, reviewer assignees, due dates**: `PUT .../sections/{key}/assignment`
  (approver), `GET .../section-assignments`, `GET /v1/me/review-queue`.
- **Change requests**: `severity` (`critical`, `major`, `minor`) on comments, non-approval
  verdicts and `PATCH /v1/feedback/{id}`; resolutions as before.
- **Organization-wide feedback campaign**: `POST/GET .../campaigns`, `GET/PATCH
  /v1/campaigns/{id}`; everyone with an audience role is notified; counts of comments,
  participants and open change requests. Comments only; approval stays with the decider.
- **In-app notifications**: `GET /v1/me/notifications`, `POST
  /v1/notifications/{id}/read`, `POST /v1/me/notifications/read-all`. Kinds: comment,
  reply, assignment, rereview_requested, campaign, patch_proposed, published. Only the
  recipient sees them. Slack is wave 2 (`v2-chat`).
- The one-time evidence-grounded pushback and the override log are unchanged
  (`oracle/jobs`); a publication pins the override log.

## Publish

`GET .../versions/{n}/publish-check` lists blockers and warnings; `POST
.../versions/{n}/publish` (approver, optional `content_hash` the publisher checked)
runs the same check under the **publish lock** and either refuses (409 `PublishRefused`
with the check, nothing written) or writes a publication. The publish lock is the
document's row lock plus the company's review gate (a transaction advisory lock) taken
shared. Section verdicts, version approvals, document policy changes and accepted
patches take the document's row lock; source revocations (deleted sources and
connections, any revoking `source_permission` event) and changes to the company
settings `review_policy` and `publish_latest_only` take the gate exclusively. So
nothing the check reads commits while a publish renders.

| Blocker | When |
|---|---|
| `version_not_approved` / `approval_not_by_decider` | The version lacks the final approval, or it is not the designated decider's. |
| `version_approval_lapsed` | The version's approval lapsed for good (its approver demoted or disabled, its token revoked), or its approver is no longer one now. |
| `decider_not_current` | The policy's designated decider is no longer an approver; change the review policy. |
| `missing_required_section` | A required section (template version, composition, policy) is absent. |
| `stale_approval` / `missing_approval` | A section the policy requires has no approval of its current revision. |
| `mandatory_reviewer_pending` | A mandatory reviewer has not approved the current revisions, or is no longer an approver. |
| `open_critical_change_request` | A critical change request is still open (T2: a critical unresolved blocker). |
| `readiness_critical` | A **hard** check of `oracle.readiness.evaluate(purpose="publish")` is critical (the blockers lane's critical-blocker check, security and policy checks). |
| `template_unresolved` | The version names a template whose required sections cannot be read (unknown template, a `template_version` that is not a number or does not exist). Fails closed. |
| `source_permission_revoked` | Evidence of the version comes from a revoked source. The evidence is followed back to source items: section links to an item, to baseline evidence and to an entity (and its evidence), and citations by normalized URL (`http` as
`https`, no `www.`, no trailing slash, percent-escapes in one form, no tracking query
parameters, the rest sorted; a Google Docs, Sheets, Slides, Forms or Drive URL is its
document id whatever the view, `/edit`, `/view`, `/preview`, `/u/<n>` or `?usp=`; the
host lookup also finds a URL with a user name), by item id, by evidence id, or by the
item's external id in a source of the citation's kind (a ref that parses as a UUID is
tried as an item id, an evidence id and an external id, so a Notion page id is matched). Revoked: a deleted item, a source on a revoked connection, a source / item whose last `source_permission` event revoked it, or a revocation tombstone naming the item, its URL, the evidence or the link. |
| `superseded_version` | A newer version exists and the company setting `publish_latest_only` (default true) is on. |
| `already_published` | The version is already a publication. |

Warnings never block (T2): advisory readiness results, open change requests that are
not critical, lapsed approvals on sections that need none, overdue reviews.
The lane also registers its invariants as the hard readiness check `review_approvals`
for the readiness dashboard; the publish check computes them itself and skips it.

Contract for lanes recording permission changes: `record_change(db, "source_permission",
cause="revoked" | "permission_revoked" | "source_revoked" | "source_deleted" |
"connection_revoked" | "acl_narrowed", subject_id=<source or source item id>)`, and
`cause="restored" | "permission_restored" | "granted"` to lift it; `document_id` alone
revokes for the whole document. Optional `data`: `item_ids`, `urls` (normalized),
`evidence_ids` and `links` (`id`, `document_id`, `version_id`, `section_key`) widen the
match.

**Revocation tombstones.** `DELETE /v1/sources/{id}` and `DELETE /v1/connections/{id}`
hard-delete (items cascade; a connection's sources keep their items but lose access).
Before that, `oracle.review.publish.record_source_revocation` records one
`source_permission` event per source (`source_revoked` or `connection_revoked`) whose
data is the tombstone: the items' ids, external ids and normalized URLs, the baseline
evidence from
them and the section links to them. A section link to the item alone goes with the
delete (its target check forbids a null target); the tombstone keeps it.

**A publication** (`document_publications`) pins: the version (id, number, content hash,
markdown), the template version (key, version, body hash, required sections), the
composition revision (number, status, modules), the last approval and the decider, the
mandatory reviewers, each section's revision, status and approval, the evidence
snapshot (source snapshot, citations with their sections, section links), the Sources and
data points appendix, the pushback override log, the readiness results and warnings, and
the rendered HTML (full, brief and deck). `manifest_hash` is a sha256 over the canonical
manifest and the markdown. A database trigger refuses any UPDATE of the row and any
DELETE that is not a cascade from deleting its document or company. The version
foreign key is NO ACTION (checked at the end of the statement): a published version is
never deleted on its own, while deleting the document or the company removes both. Exports
(`GET .../publications/{p}/export?format=html|pdf|md&layer=full|brief|deck`) are served
from the stored HTML and markdown, so later edits, theme changes and source updates never
change them. Publishing writes `document.publish` to the audit log and notifies the
approver and section owners.

## Routes (all `/v1`, all company scoped, MCP tools from OpenAPI)

| Method and path | Role | Tool |
|---|---|---|
| GET `/documents/{doc}/versions/{n}/section-states` | viewer | `get_section_states` |
| GET `/documents/{doc}/section-assignments` | viewer | `list_section_assignments` |
| PUT `/documents/{doc}/sections/{key}/assignment` | approver | `put_section_assignment` |
| GET `/me/review-queue` | viewer | `get_my_review_queue` |
| GET, PUT `/documents/{doc}/review-policy` | viewer, owner | `get_review_policy`, `put_review_policy` |
| PUT `/documents/{doc}/sections/{key}` | commenter (approver or section owner) | `edit_document_section` |
| GET `/documents/{doc}/section-patches` | viewer | `list_section_patches` |
| GET `/section-patches/{id}`; POST `.../accept`, `.../reject` | viewer; approver | `get_section_patch`, `accept_section_patch`, `reject_section_patch` |
| POST, GET `/documents/{doc}/campaigns`; GET, PATCH `/campaigns/{id}` | approver, viewer | `create_review_campaign`, `list_review_campaigns`, `get_review_campaign`, `update_review_campaign` |
| GET `/me/notifications`; POST `/notifications/{id}/read`, `/me/notifications/read-all` | viewer (own only) | `list_my_notifications`, `read_notification`, `read_all_notifications` |
| GET `/documents/{doc}/versions/{n}/publish-check` | viewer | `get_publish_check` |
| POST `/documents/{doc}/versions/{n}/publish` | approver | `publish_version` |
| GET `/documents/{doc}/publications[/{p}[/export]]` | viewer | `list_publications`, `get_publication`, `export_publication` |

Extended: `POST .../versions?base_version=`, `PUT .../sections/{key}/review` (`revision`,
`severity`, 409), `POST .../comments` (`severity`), `PATCH /feedback/{id}` (`severity`),
`POST .../approve` (decider, current version, re-approval), `PUT /settings/review_policy`,
`PUT /settings/publish_latest_only`, `oracle push` (pulled base, `--base N`), MCP
`push_draft` (`base_version`), `VersionOut.notes`, `SectionOut.revision`,
`SectionPatchOut.action`, `ConflictResponse.front_matter_changed`.

## Data (`0014_review`, additive)

`section_review_states`, `document_review_policies`, `review_campaigns`, `notifications`,
`section_patches` (with `action`), `document_publications` (+ trigger
`document_publications_immutable` on UPDATE and DELETE), `feedback_items.severity`
(nullable, checked), `document_versions.notes` (default `[]`) and `sections.revision`
(backfilled), and `change_events.subject_kind` admits `member`. Nothing in 0013 or
earlier changes; legacy rows read as before.

`0014_member_disable` (on `0014_review`): `users.disabled_at`, `disabled_by`,
`sessions_valid_after`; `section_reviews.token_id`, `grant_id` (indexed), `lapsed_at`,
`lapse_reason`; `document_versions.approved_token_id`, `approved_grant_id` (indexed),
`approval_lapsed_at`, `approval_lapsed_by`, `approval_lapse_reason`, `approval_lapses`
(default `[]`); `audit_events.actor_token_id`, `actor_grant_id`; the
`member_follow_ups` table. Its upgrade backfills: every un-lapsed approval (section or
version) by a member already below approver lapses for good with reason "demoted before
this change" (a document left with no approved version goes back to in_review; one
`approval.lapse` audit event per person). Its downgrade refuses while a member is
disabled, an approval has lapsed or a follow-up is pending (dropping the columns would
let them back).

## Tests

`api/tests/test_review_v2_state.py` (§16.10), `test_review_v2_concurrency.py` (409s,
parallel sections, base version, CLI), `test_review_v2_publish.py` (§16.11 gate half,
§16.17), `test_review_v2_routes.py` (§16.12, §16.22), `test_review_v2_legacy.py` (§16.1
next to the legacy suite), `test_review_v2_security.py` (the security review fixes: real
revocations, confined section edits, agent drafts, evidence in revisions, the minors),
`test_review_v2_security_2.py` (round 2: approvals by current approvers only, member
removal, the unclosed fence, revocation matching, links in the review revision, one
markdown env per exported section, criticals gate, run resolutions),
`test_review_v2_security_3.py` (round 3, C2: disable instead of delete on every sign-in
path, lapses for good, approvals by token, the fence with trailing blank lines and lost
sections, a UUID citation as an external id, Google Docs and percent-encoded URLs, URLs
with a user name), `test_review_v2_security_4.py` (round 4, C2 follow-ups: sessions end
at a disable, the caller re-read under the gate, outbound calls after the commit, OAuth
grants, UUID refs in any spelling, credentials racing a disable, what else a disable
reaches) and `test_member_disable_migration.py` (the backfill on a populated database).
