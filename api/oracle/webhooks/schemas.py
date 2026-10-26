"""Webhook payloads, one model per event type (Q3: ids, types, states, titles, names and
links only), and the webhooks API's requests and responses.

A payload never carries document or section text, comments, feedback, checkpoint notes,
source items or excerpts, interview content, run prompts or errors as free text, costs,
emails or user ids (tests.test_webhooks_events pins every model's fields to an allowlist).
The models are published in OpenAPI as ``components.schemas.WebhookEvent_<type>`` and as
OpenAPI 3.1 ``webhooks:`` entries (:func:`openapi_webhooks`).
"""

import uuid
from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, create_model, field_validator
from pydantic.json_schema import models_json_schema

# Fixed per webhook at creation; a breaking payload change adds a new one.
API_VERSION = "2026-10-25"
MAX_URL = 2048
MAX_NAME = 80
EventGroup = Literal["runs", "drafts", "approvals"]


# --- payloads ---------------------------------------------------------------------------


class WebhookCompany(BaseModel):
    # Companies have no slug in Oracle: their id and name.
    id: uuid.UUID
    name: str


class WebhookActor(BaseModel):
    kind: Literal["person", "oracle", "system"]
    # A person's display name; never an id or an email.
    name: str | None = None


class WebhookRun(BaseModel):
    id: uuid.UUID
    flow: str
    status: str
    title: str | None = None
    url: str
    # run.failed: a code, never the free-text error.
    error_kind: str | None = None


class WebhookCheckpoint(BaseModel):
    id: uuid.UUID
    kind: str
    approver_role: str
    url: str
    # run.checkpoint_decided only; the note's text is never sent.
    outcome: Literal["approved", "changes_requested"] | None = None


class WebhookDocument(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    version: int | None = None
    url: str
    # draft.version_created: run, agent or person.
    origin: str | None = None


class WebhookRunData(BaseModel):
    run: WebhookRun
    actor: WebhookActor


class WebhookCheckpointData(BaseModel):
    run: WebhookRun
    checkpoint: WebhookCheckpoint
    actor: WebhookActor


class WebhookDocumentData(BaseModel):
    document: WebhookDocument
    actor: WebhookActor


class WebhookApprovalData(BaseModel):
    document: WebhookDocument
    approver: WebhookActor
    actor: WebhookActor


class WebhookInvalidatedData(BaseModel):
    document: WebhookDocument
    # A code: edited, approver_demoted, approver_disabled, token_revoked, grant_revoked.
    reason: str
    actor: WebhookActor


def payload_model(event_type: str, data: type[BaseModel]) -> type[BaseModel]:
    """The envelope of one event type: ``WebhookEvent_<type>``."""
    return create_model(
        f"WebhookEvent_{event_type.replace('.', '_')}",
        __doc__=f"The body Oracle posts for a {event_type} event.",
        id=(str, Field(description="evt_<ulid>: unique, the receivers' idempotency key")),
        type=(Literal[event_type], ...),  # type: ignore[valid-type]
        api_version=(str, ...),
        occurred_at=(datetime, ...),
        company=(WebhookCompany, ...),
        data=(data, ...),
    )


def openapi_webhooks(event_types: dict[str, Any]) -> tuple[dict, dict]:
    """``(webhooks, component schemas)`` for the OpenAPI document: one ``webhooks:`` entry
    per type, its body ``#/components/schemas/WebhookEvent_<type>``."""
    keys = [(et.payload, "serialization") for et in event_types.values()]
    _, top = models_json_schema(keys, ref_template="#/components/schemas/{model}")
    components = dict(top.get("$defs", {}))
    hooks: dict[str, Any] = {}
    for name, et in event_types.items():
        component = f"WebhookEvent_{name}"
        components[component] = components.pop(et.payload.__name__)
        hooks[name] = {
            "post": {
                "summary": et.label,
                "operationId": f"webhook_{name.replace('.', '_')}",
                "requestBody": {
                    "required": True,
                    "content": {
                        "application/json": {
                            "schema": {"$ref": f"#/components/schemas/{component}"}
                        }
                    },
                },
                "responses": {"2XX": {"description": "Received"}},
            }
        }
    # A model's own refs name it by its Python name; point them at the published one.
    renames = {
        f"#/components/schemas/{et.payload.__name__}": f"#/components/schemas/WebhookEvent_{n}"
        for n, et in event_types.items()
    }
    return hooks, _renamed(components, renames)


def _renamed(value: Any, renames: dict[str, str]) -> Any:
    if isinstance(value, dict):
        return {
            k: (renames.get(v, v) if k == "$ref" else _renamed(v, renames))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_renamed(v, renames) for v in value]
    return value


# --- the API ----------------------------------------------------------------------------


class EventTypeOut(BaseModel):
    type: str
    group: EventGroup
    label: str
    # Whether an event of this type can be about owners-and-approvers content (Q2).
    can_be_approvers_only: bool


class PersonName(BaseModel):
    name: str


class LastDelivery(BaseModel):
    status: str
    at: datetime | None
    http_status: int | None


class WebhookOut(BaseModel):
    id: uuid.UUID
    name: str
    url: str
    host: str
    event_types: list[str]
    api_version: str
    include_approvers_content: bool
    status: Literal["active", "paused"]
    paused_reason: (
        Literal["manual", "failing", "gone", "creator_disabled", "creator_demoted"] | None
    )
    # The secret's last 4 characters; the secret itself is shown once, at create or rotate.
    secret_hint: str
    secret_rotated_at: datetime
    created_by: PersonName
    created_at: datetime
    last_delivery: LastDelivery | None = None
    failing_since: datetime | None = None
    # Whether the caller may take it over (owners, on a paused webhook of someone else).
    can_take_over: bool = False


class WebhookCreated(BaseModel):
    webhook: WebhookOut
    # Shown once: Oracle never returns it again.
    secret: str


def _check_url(v: str) -> str:
    v = v.strip()
    if len(v) > MAX_URL:
        raise ValueError(f"The URL is longer than {MAX_URL} characters")
    try:
        parts = urlsplit(v)
        port = parts.port
    except ValueError:
        raise ValueError("Not a URL") from None
    del port
    if parts.scheme != "https" or not parts.hostname:
        raise ValueError("Webhooks send to https:// addresses only")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise ValueError("The URL may not hold a user name or password")
    return v


def _check_types(v: list[str]) -> list[str]:
    from oracle.webhooks.events import EVENT_TYPES

    unknown = [t for t in v if t not in EVENT_TYPES]
    if unknown:
        raise ValueError(f"Unknown event types: {', '.join(unknown)}")
    if not v:
        raise ValueError("Pick at least one event")
    # In the registry's order, once each.
    return [t for t in EVENT_TYPES if t in set(v)]


class WebhookIn(BaseModel):
    name: str = Field(min_length=1, max_length=MAX_NAME)
    url: str
    event_types: list[str] = Field(max_length=20)
    include_approvers_content: bool = False
    # Required to turn owners-and-approvers content on (Q2).
    reason: str | None = Field(default=None, max_length=500)

    _url = field_validator("url")(_check_url)
    _types = field_validator("event_types")(_check_types)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("A name is required")
        return v.strip()


class WebhookPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=MAX_NAME)
    url: str | None = None
    event_types: list[str] | None = Field(default=None, max_length=20)
    status: Literal["active", "paused"] | None = None
    include_approvers_content: bool | None = None
    reason: str | None = Field(default=None, max_length=500)

    @field_validator("url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        return None if v is None else _check_url(v)

    @field_validator("event_types")
    @classmethod
    def _types(cls, v: list[str] | None) -> list[str] | None:
        return None if v is None else _check_types(v)


class RotateIn(BaseModel):
    # Skip the 24-hour overlap: only the new secret signs from now on.
    end_old_now: bool = False


class DeliveryOut(BaseModel):
    id: uuid.UUID
    event_id: str
    event_type: str
    status: Literal["pending", "retrying", "succeeded", "failed", "withheld"]
    attempts: int
    next_at: datetime | None
    last_at: datetime | None
    http_status: int | None
    duration_ms: int | None
    error: str | None
    response_excerpt: str | None
    body: dict[str, Any] | None
    redelivery_of: uuid.UUID | None
    created_at: datetime


class DeliveryPage(BaseModel):
    items: list[DeliveryOut]
    # Pass as ``before`` for the next (older) page; None at the end.
    next_before: datetime | None = None
