"""CR-07 review fixes, round 7 (PR #78, on #69 / #57 / #45 / #38), after round 6's
security review: a cancelled run (or a disabled member's) never comes back to life, the
tick holds no run row lock across a SwarmCloud call, and the review gate is not held
while a client's request body is read. Synthetic placeholders only."""

import asyncio

import pytest

from oracle import readiness
from tests.review_v2_helpers import DOC, DRAFT, MARKDOWN, person, setup
from tests.test_review_v2_security_3 import disable

WAIT = 5  # seconds: long enough for any route here, short enough to fail fast


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


# --- ITEM 3: the gate is not held while a request body is received --------------------

YAML = """entities:
  - type: feature
    key: slow-upload
    title: Slow upload
"""


class _SlowBody:
    """A request body sent in two halves, the second only once released: a client on
    a slow link."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.sent_first, self.release = asyncio.Event(), asyncio.Event()

    async def __aiter__(self):
        half = len(self.data) // 2
        yield self.data[:half]
        self.sent_first.set()
        await self.release.wait()
        yield self.data[half:]


@pytest.mark.parametrize("route", ["baseline_yaml", "document_version"])
async def test_the_gate_is_not_held_while_a_request_body_is_received(client, route):
    """An approver uploads slowly; meanwhile the owner disables another member (which
    takes the gate exclusively). The disable does not wait for the upload."""
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    other = await person(ctx.tenant_id, "commenter", "other")
    if route == "baseline_yaml":
        url, data, ctype = "/v1/baseline/yaml", YAML.encode(), "application/yaml"
    else:
        url, data, ctype = f"/v1/documents/{DOC}/versions", DRAFT.encode(), MARKDOWN["Content-Type"]
    body = _SlowBody(data)
    upload = asyncio.create_task(
        client.post(url, content=body, headers={**approver.headers, "Content-Type": ctype})
    )
    try:
        await asyncio.wait_for(body.sent_first.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, other.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not upload.done()
    finally:
        body.release.set()
    resp = await asyncio.wait_for(upload, WAIT)
    assert resp.status_code in (200, 201), resp.text


@pytest.mark.parametrize("route", ["baseline_yaml", "document_version"])
async def test_a_request_body_over_the_limit_is_refused_before_the_gate(client, monkeypatch, route):
    from oracle import http
    from oracle.review import publish

    ctx = await setup(client)
    monkeypatch.setattr(http, "MAX_BODY_BYTES", 64)
    taken: list[bool] = []
    real = publish.gate_lock

    async def spy(db, *, shared):
        taken.append(shared)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    if route == "baseline_yaml":
        url, ctype = "/v1/baseline/yaml", "application/yaml"
    else:
        url, ctype = f"/v1/documents/{DOC}/versions", MARKDOWN["Content-Type"]

    async def chunks():  # no Content-Length: the limit holds while reading
        yield b"x" * 50
        yield b"x" * 50

    resp = await client.post(url, content=chunks(), headers={**ctx.auth, "Content-Type": ctype})
    assert resp.status_code == 413, resp.text
    assert taken == []
