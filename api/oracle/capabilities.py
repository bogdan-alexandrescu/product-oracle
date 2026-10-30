"""What a role may do (#370), read off the routes' own role checks.

Each operation that resolves the caller needs the highest role any of its
:func:`oracle.authz.require_role` dependencies names (a router's and the route's own).
A route that checks no role is listed below, so a new route without one fails
tests/test_capabilities.py. A route whose check also lets the engineering lead through
names ``lead_role`` too (the date checks), and the handlers' own role checks are listed in
:data:`PER_ITEM`. ``GET /v1/me/capabilities`` answers, per operation, whether
the caller's role reaches it; the web app hides what it does not, and the OpenAPI
document carries each operation's role as ``x-min-role`` for the web app's mock.
"""

from collections.abc import Callable, Iterator
from typing import Any

from fastapi import FastAPI
from fastapi.routing import APIRoute

from oracle.auth.deps import get_principal
from oracle.auth.models import ROLES, Role
from oracle.authz import has_role

# Open to every member: their own account, tokens, connections and sources, and reads.
EVERY_MEMBER = frozenset(
    {
        "authorize_connection",
        "change_password",
        "compare_priority_snapshot",
        "connect_with_token",
        "create_personal_token",
        "create_snapshot",
        "delete_connection",
        "get_checkpoint_review_file",
        "get_company_source_coverage",
        "get_draft_defaults",
        "get_inbox",
        "get_my_account",
        "get_preferences",
        "get_priorities",
        "get_priority_calibration",
        "get_prd_scope_review",
        "get_priority_snapshot",
        "get_run",
        "get_run_artifact",
        "get_run_scope",
        "get_setup",
        "get_snapshot",
        "get_source",
        "get_source_coverage",
        "get_source_item",
        "get_strategy_stack",
        "get_template",
        "get_template_version",
        "get_theme",
        "list_connections",
        "list_fireflies_meetings",
        "list_fireflies_series",
        "list_flows",
        "list_github_repos",
        "list_google_drive_files",
        "list_google_shared_drives",
        "list_my_oauth_clients",
        "list_my_tokens",
        "list_notion_pages",
        "list_priority_overrides",
        "list_priority_snapshots",
        "list_providers",
        "list_run_decisions",
        "list_runs",
        "list_slack_channels",
        "list_snapshot_items",
        "list_snapshots",
        "list_source_coverage",
        "list_source_items",
        "list_source_kinds",
        "list_sources",
        "list_strategy_findings",
        "list_templates",
        "list_themes",
        # #710: live reads of the caller's own connections only.
        "live_fireflies_get_lines",
        "live_fireflies_get_meeting",
        "live_fireflies_list_meetings",
        "live_fireflies_search",
        "live_sources",
        "me",
        "oauth_callback",
        "oauth_slack_notifications_callback",
        "preview_theme",
        "recommend_draft",
        "reconnect_connection",
        "revoke_my_oauth_client",
        "revoke_my_token",
        "search_sources",
        "sign_out_everywhere",
        "update_my_account",
        "update_preferences",
        "validate_template",
        "validate_theme",
        "capabilities",
    }
)

# Run tokens only (H7: the web tools need read:web, which only the competitive digest's
# run holds): a person's role never reaches them, whatever the route's role check says.
RUN_ONLY = frozenset({"fetch_web_page", "search_web", "get_intake_analysis_input"})

# Decided in the handler against the item: a checkpoint's approver role, the author, the
# role Oracle acted with. Any role may hold the item, so the page reads the item's own
# state to show or hide these.
DECIDED_PER_ITEM = frozenset(
    {
        "accept_scope_enhancement",
        "add_scope_requirement",
        "create_checkpoint_action",
        "decide_checkpoint",
        "delete_checkpoint_action",
        "delete_scope_item",
        "enhance_scope_requirement",
        "get_checkpoint_draft",
        "open_oracle_action",
        "patch_scope_item",
        "retry_draft_import",
        "set_checkpoint_note",
        "stage_checkpoint_action",
        "tick",
        "undo_oracle_action",
    }
)

# Operations whose handler can still refuse a role the route lets in, for this item or this
# input (the intake's author, the person asked, a critical gap, the checkpoint's own role).
# Each names the role the handler never refuses on role grounds; below it the item decides
# (None: only the item does, e.g. the decision's named approver). A vision, strategy or
# update is an owner's to start or approve (by its kind); a blocker that gates publishing
# the company's acceptance role's, an owner at most; a run an owner's or its creator's; a
# request filed for someone else an owner's (a commenter files their own); a customer
# interview its creator's or an approver's, a team interview its interviewee's alone; a
# slipped date's acceptance the date rights' (F3), an owner's whoever is lead; a scope
# review's rows (C7) the feature-set stop's approver role's. A discussion's change (G3) is a
# writer's in it to add, edit or suggest, an approver's to stage, dismiss, resolve or record
# (the date rights), a commenter's to propose, and the person asked's too to use as an answer.
# Research this in a discussion (G2 §4) is an approver's who can write in it, while it is open.
# Simple (#723): a goal's suggestions are asked for and filed by any commenter, and accepted or
# rejected (final) by an owner or whoever decides the goal's roadmap (S7: drafts.can_edit, so
# with no decider its owners who are approvers; "owner" here, the suggestion's can_accept /
# can_reject below it); a meeting's chat
# thread, a card and the meeting's change mode are decided by the item: its attendees, the card's
# author, the presenter (S9); the Ask panel's thread is every person's own. A visual is commented
# on by any commenter who reads it, and asked for or revised by who changes its subject directly;
# Remind is the PRD's owners' and decider's (S10, Remind): an owner always. A date suggestion's
# dismissal and a proposal are decided by an owner, the roadmap's decider or (with none) the
# item's track owner when an approver or owner (D-a); accepting or editing a suggestion is a
# change (others' a proposal, D-b); a change is undone by its author alone; the changes' list
# shows owners all, others those they made, decide or review; a submitted draft is withdrawn by
# its author or the decider.
# A share link (O5) is an owner's to make for the Public audience and an approver's for the
# others; its creator's or an owner's to extend, move or give a new passcode; and its
# creator's or an owner's to revoke when Public (any approver's otherwise).
# The capabilities answer
# carries this as ``per_item``, so the web app's can() asks the item too.
# tests/test_capabilities.py finds every role check made in a handler and fails if one is
# missing here.
PER_ITEM: dict[str, Role | None] = {
    "accept_blocker_risk": "owner",
    "accept_goal_suggestion": "owner",
    "accept_intake_proposal": "approver",
    "accept_scope_enhancement": "approver",
    "accept_simple_change": "owner",
    "accept_track_alert_date": "owner",
    "add_discussion_participants": "commenter",
    "add_scope_requirement": "approver",
    "answer_question": "owner",
    "answer_with_discussion_change": "approver",
    "apply_all_simple_chat_cards": None,
    "apply_discussion_change": "approver",
    "apply_simple_chat_card": None,
    "approve_feasibility_scope": "owner",
    "approve_in_simple_meeting": "owner",
    # Simple S3b: an owner, else the roadmap's decider (with none, its owner); required
    # reviewers approve too; the author or the decider resumes (oracle.simple.drafts).
    "approve_simple_draft": "owner",
    "approve_version": "owner",
    "ask_discussion_change": "commenter",
    "ask_next_question_batch": "approver",
    "cancel_again_run": "owner",
    "cancel_discussion_reply": "approver",
    "cancel_run": "owner",
    # S8: attendees, or whom the meeting's change mode lets change (oracle.simple.meetings).
    "choose_simple_chat_choice": None,
    "comment_in_simple_meeting": None,
    "comment_simple_visual": "commenter",
    # A Fireflies endpoint is an owner's to set (on connect, or on its own route); below
    # that, connecting without one (the input decides).
    "connect_with_token": "owner",
    "create_checkpoint_action": "owner",
    "create_discussion_change": None,
    "create_discussion_message": None,
    "create_goal_suggestion": "commenter",
    "create_intake": "approver",
    "create_interview_link": "approver",
    "create_request": "owner",
    "create_run": "owner",
    "create_share_link": "owner",
    "create_track_roadmap_run": "owner",
    "decide_checkpoint": "owner",
    "decide_decision": None,
    "decide_knowledge_gap": "owner",
    # H9: only the pricing owner, one owner (oracle.pricing.decide).
    "decide_pricing_memo": None,
    "decline_simple_change": "owner",
    "delete_checkpoint_action": "owner",
    "delete_discussion_message": None,
    "delete_scope_item": "approver",
    "discard_simple_chat_card": None,
    "dismiss_date_suggestion": "owner",
    "dismiss_discussion_change": "approver",
    "dismiss_overrun_run": "owner",
    # H10: a request's replies are its filer's, an approver's or an owner's.
    "draft_request_replies": "approver",
    "edit_document_section": "approver",
    "edit_simple_meeting_minutes": "owner",
    "end_simple_meeting": "owner",
    "enhance_scope_requirement": "approver",
    # #482: an approver, or the document's decider (per item, oracle.trash.router).
    "estimate_regeneration": "approver",
    # H5: the metric's owner (any role) or an approver; so are its unknown and its values.
    "explain_metric_variance": "approver",
    # O5: a roadmap's Public audience is an approver's (Board, Team and Engineering are
    # every reader's: the audience query parameter decides).
    "export_publication": "approver",
    "export_version": "approver",
    # Filing a found item in the app for someone else is an owner's, as create_request.
    "file_request_candidate": "owner",
    "get_checkpoint_draft": "owner",
    # Company coverage is owners' only (owner 2026-10-24): its handler reads the role.
    "get_company_source_coverage": "owner",
    "get_deck": "approver",
    "get_next_question_batch": "approver",
    "get_simple_chat": "viewer",
    "get_simple_meeting_chat": None,
    "keep_request_no": None,
    # #618 review: a track alert's audience keeps and reopens it (oracle.roadmap.alerts
    # in_audience): the track's owner, else every owner, and the leads for slips.
    "keep_track_alert": None,
    "list_simple_changes": "owner",
    "make_new_interview_link": "approver",
    "mark_metric_variance_unknown": "approver",
    "mark_request_reply_sent": "approver",
    "mirror_discussion_to_slack": "approver",
    "notify_request_reply": "approver",
    "open_oracle_action": "owner",
    # H10: an answer told in Oracle is its asker's alone to mark opened.
    "open_request_reply": None,
    "patch_interview": "approver",
    "patch_scope_item": "approver",
    "post_simple_chat": "viewer",
    "post_simple_meeting_chat": None,
    "propose_discussion_change": "commenter",
    "reassign_decision": "owner",
    "record_discussion_change": "approver",
    "record_metric_value": "approver",
    "redraft_interview_guide": "approver",
    "redraft_simple_meeting_minutes": "owner",
    "regenerate_spec": "owner",
    "reject_goal_suggestion": "owner",
    "remind_simple_one_pager_reviewers": "owner",
    "remove_evidence": "approver",
    "reopen_track_alert": None,
    "retry_simple_meeting_delivery": "owner",
    "request_simple_visual": "owner",
    "research_discussion_message": "approver",
    "resolve_discussion_change": "approver",
    "resume_simple_draft": None,
    "retry_discussion_reply": "approver",
    "retry_draft_import": "owner",
    "retry_import_run": "owner",
    "retry_lookup_run": "owner",
    "retry_run": "owner",
    "retry_simple_chat_read": None,
    "review_decision": None,
    "review_design_artifact": "owner",
    "revise_simple_visual": "owner",
    "revoke_interview": "approver",
    "revoke_share_link": "owner",
    "rotate_share_link_passcode": "owner",
    "send_simple_meeting_minutes": "owner",
    "set_blocker_status": "owner",
    "set_checkpoint_note": "owner",
    "set_connection_endpoint": "owner",
    "set_document_visibility": "owner",
    "set_simple_meeting_chat_mode": None,
    # S8: the meeting's presenter alone (oracle.simple.meetings.set_rules).
    "set_simple_meeting_rules": None,
    "skip_request_reply": "approver",
    "stage_checkpoint_action": "owner",
    "stage_discussion_change": "approver",
    "start_draft": "owner",
    "start_intake_run": "approver",
    "start_regeneration": "approver",
    "start_simple_meeting": "owner",
    "stop_cancelling_run": "owner",
    "stop_slack_mirror": "approver",
    "submit_simple_draft": "owner",
    "suggest_discussion_change": None,
    "suggest_goal_features": "commenter",
    "summarize_discussion": None,
    "take_team_turn": None,
    "tick": "owner",
    "undo_oracle_action": "owner",
    "undo_simple_change": None,
    "undo_simple_chat_card": None,
    "update_blocker": "owner",
    "update_decision": None,
    "update_discussion": None,
    "update_discussion_change": None,
    "update_discussion_message": None,
    "update_intake": "owner",
    "update_knowledge_gap": "owner",
    "update_launch_task": "approver",
    "update_question": "approver",
    "update_request_reply": "approver",
    "update_requester_note": "approver",
    "update_share_link": "owner",
    "waive_strategy_finding": "owner",
    "withdraw_decision": "owner",
    "withdraw_discussion_change": None,
    # H11 questions: the intake's author or an approver, as asking them.
    "withdraw_intake_questions": "approver",
    # qa-simple-plan-30: a waiting proposal is withdrawn by who proposed it alone.
    "withdraw_simple_change": None,
    "withdraw_simple_draft": None,
}


def _calls(dependant: Any) -> Iterator[Callable[..., Any]]:
    yield dependant.call
    for sub in dependant.dependencies:
        yield from _calls(sub)


def _routes(routes: list[Any]) -> Iterator[APIRoute]:
    """Every APIRoute, through included routers (FastAPI nests them)."""
    for r in routes:
        if isinstance(r, APIRoute):
            yield r
        elif hasattr(r, "original_router"):
            yield from _routes(r.original_router.routes)


_cache: dict[int, dict[str, Role]] = {}
_lead_cache: dict[int, dict[str, Role]] = {}


def operation_roles(app: FastAPI) -> dict[str, Role]:
    """operationId -> the least role that may call it, for every route that resolves the
    caller. Routes without a role check (the lists above) count as viewer."""
    key = id(app)
    if key not in _cache:
        roles: dict[str, Role] = {}
        for route in _routes(app.router.routes):
            calls = list(_calls(route.dependant))
            if get_principal not in calls:
                continue
            named = [getattr(c, "min_role", None) for c in calls]
            roles[route.name] = max((r for r in named if r), key=ROLES.index, default="viewer")  # type: ignore[assignment]
        _cache[key] = roles
    return _cache[key]


def lead_roles(app: FastAPI) -> dict[str, Role]:
    """operationId -> the least role an engineering lead needs, for routes whose check also
    lets the engineering lead through (``lead_role`` beside ``min_role``: the date checks)."""
    key = id(app)
    if key not in _lead_cache:
        _lead_cache[key] = {
            route.name: lead
            for route in _routes(app.router.routes)
            for c in _calls(route.dependant)
            if (lead := getattr(c, "lead_role", None))
        }
    return _lead_cache[key]


def capabilities(app: FastAPI, role: str, engineering_lead: bool = False) -> dict[str, bool]:
    leads = lead_roles(app) if engineering_lead else {}
    return {
        op: op not in RUN_ONLY
        and (has_role(role, need) or (op in leads and has_role(role, leads[op])))
        for op, need in operation_roles(app).items()
    }


def stamp_openapi(app: FastAPI) -> None:
    """Add ``x-min-role`` to each operation of the app's OpenAPI document."""
    build = app.openapi

    def openapi() -> dict[str, Any]:
        if app.openapi_schema:
            return app.openapi_schema
        schema = build()
        roles, leads = operation_roles(app), lead_roles(app)
        for ops in schema["paths"].values():
            for op in ops.values():
                if op.get("operationId") in roles:
                    op["x-min-role"] = roles[op["operationId"]]
                if op.get("operationId") in leads:
                    op["x-lead-role"] = leads[op["operationId"]]
                if op.get("operationId") in PER_ITEM:
                    op["x-per-item"] = PER_ITEM[op["operationId"]]
                if op.get("operationId") in RUN_ONLY:
                    op["x-run-only"] = True
        return schema

    app.openapi = openapi  # type: ignore[method-assign]
