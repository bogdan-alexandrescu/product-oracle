"""Helpers for the v2 review tests (CR-06): a synthetic PRD, people with roles, and
small wrappers over the review routes. Synthetic placeholders only."""

import uuid
from dataclasses import dataclass

from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth

DOC = "team-calendar"
MARKDOWN = {"Content-Type": "text/markdown"}

DRAFT = """---
document: team-calendar
title: Team calendar PRD
citations:
  - id: c1
    source: web
    ref: https://example.com/calendar-survey
    title: Calendar survey
---

# Team calendar PRD {#title}

Owner: product.

## Goal trace {#goal-trace}

Serves the retention goal: teams that plan together stay [c:c1].

## Problem {#problem}

Teams miss shared deadlines.

## Solution {#solution}

A shared calendar view per project.

## Risks {#risks}

Calendar sync may lag.

## Sources and data points {#sources}

- Calendar survey, as of September.
"""


@dataclass
class Person:
    user_id: uuid.UUID
    headers: dict[str, str]


@dataclass
class Ctx:
    tenant_id: uuid.UUID
    auth: dict[str, str]  # an owner API token

    def v(self, n: int, tail: str = "") -> str:
        return f"/v1/documents/{DOC}/versions/{n}{tail}"


async def person(tenant_id: uuid.UUID, role: str, name: str | None = None) -> Person:
    async with tenant_session(tenant_id) as s:
        email = f"{name or role}-{uuid.uuid4().hex[:8]}@example.com"
        user = await create_user(s, email, "pw")
        user.role = role
        await s.commit()
        cookie = make_session_cookie(user)
        return Person(user.id, {"Cookie": f"{get_settings().session_cookie_name}={cookie}"})


async def setup(client, draft: str = DRAFT) -> Ctx:
    tenant_id, auth = await seed_auth()
    resp = await import_md(client, auth, draft)
    assert resp.status_code == 201, resp.text
    return Ctx(tenant_id, auth)


async def import_md(client, headers, text: str, doc: str = DOC, base: int | None = None):
    return await client.post(
        f"/v1/documents/{doc}/versions",
        content=text.encode(),
        headers={**headers, **MARKDOWN},
        params={"base_version": base} if base is not None else None,
    )


async def states(client, headers, n: int, doc: str = DOC) -> dict[str, dict]:
    resp = await client.get(f"/v1/documents/{doc}/versions/{n}/section-states", headers=headers)
    assert resp.status_code == 200, resp.text
    return {s["section_key"]: s for s in resp.json()["sections"]}


async def verdict(client, headers, n: int, key: str, value: str = "approved", **extra):
    return await client.put(
        f"/v1/documents/{DOC}/versions/{n}/sections/{key}/review",
        json={"verdict": value, **extra},
        headers=headers,
    )


async def edit(client, headers, key: str, base: int, revision: str, body: str, **extra):
    return await client.put(
        f"/v1/documents/{DOC}/sections/{key}",
        json={"base_version": base, "base_revision": revision, "body_md": body, **extra},
        headers=headers,
    )


async def approve_all(client, headers, n: int) -> None:
    for key in await states(client, headers, n):
        assert (await verdict(client, headers, n, key)).status_code == 200


def replace(draft: str, old: str, new: str) -> str:
    assert old in draft
    return draft.replace(old, new)
