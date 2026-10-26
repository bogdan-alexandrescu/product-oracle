"""PR #128 auth note: the merge with main kept two run markers on the MCP server's
in-process REST call, #128's ``x-oracle-run-token`` (the run token, re-read under the
review gate) and main's server-signed ``x-oracle-run-id`` binding. Either alone marks the
call as the run's; together they must name the same run. A forged or unsigned run id is
refused (400, fail closed), a revoked run token is refused (401), and both naming the same
run act as that run. Synthetic placeholders only."""

import uuid

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from oracle.auth import deps
from oracle.auth.deps import RUN_HEADER, RUN_TOKEN_HEADER
from oracle.auth.service import sign_run_binding
from oracle.config import get_settings
from oracle.runs.models import Run
from oracle.runtokens import mint_run_token, revoke_run_tokens
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, person, setup


async def _run(tenant_id: uuid.UUID, user_id: uuid.UUID) -> tuple[uuid.UUID, str]:
    """A running run the person started, and an active run token for it."""
    async with tenant_session(tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=user_id, status="running")
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, ["read:documents"], 600)
        await s.commit()
        return run.id, raw


async def _principal(headers: dict[str, str]) -> deps.Principal:
    """What the API makes of the headers (the session cookie and the run markers)."""
    request = Request(
        {
            "type": "http",
            "method": "GET",
            "path": f"/v1/documents/{DOC}",
            "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        }
    )
    cookie = headers["Cookie"].split("=", 1)[1]
    return await deps.get_principal(request, None, cookie)


def _read(client, headers: dict[str, str]):
    return client.get(f"/v1/documents/{DOC}", headers=headers)


async def test_both_markers_naming_the_same_run_act_as_that_run(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    run_id, raw = await _run(ctx.tenant_id, pm.user_id)
    both = {**pm.headers, RUN_TOKEN_HEADER: raw, RUN_HEADER: sign_run_binding(pm.user_id, run_id)}
    assert (await _read(client, both)).status_code == 200
    principal = await _principal(both)
    assert principal.run_id == run_id and principal.run_token_id is not None
    # The binding alone marks the call as the run's too; the token alone is refused
    # (only Oracle's in-process MCP call carries a binding).
    with pytest.raises(HTTPException) as refused:
        await _principal({**pm.headers, RUN_TOKEN_HEADER: raw})
    assert refused.value.status_code == 403
    bound = await _principal({**pm.headers, RUN_HEADER: sign_run_binding(pm.user_id, run_id)})
    assert bound.run_id == run_id and bound.run_token_id is None


async def test_a_forged_or_unsigned_run_id_is_refused_beside_a_valid_run_token(client, monkeypatch):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    other = await person(ctx.tenant_id, "approver", "other")
    run_id, raw = await _run(ctx.tenant_id, pm.user_id)
    second, _ = await _run(ctx.tenant_id, pm.user_id)
    cases = {
        "unsigned run id": str(run_id),
        "garbage": "not-a-signed-value",
        "signed for another user": sign_run_binding(other.user_id, run_id),
        "signed for another run": sign_run_binding(pm.user_id, second),
    }
    for label, value in cases.items():
        for headers in (
            {**pm.headers, RUN_HEADER: value},
            {**pm.headers, RUN_TOKEN_HEADER: raw, RUN_HEADER: value},
        ):
            resp = await _read(client, headers)
            if label == "signed for another run" and RUN_TOKEN_HEADER not in headers:
                # A valid binding alone: the run it names (the person's own second run).
                assert resp.status_code == 200, (label, resp.text)
                continue
            assert resp.status_code == 400, (label, headers.keys(), resp.text)
            assert RUN_HEADER in resp.json()["detail"], (label, resp.text)
    # An expired binding is a forged one too.
    good = sign_run_binding(pm.user_id, run_id)
    monkeypatch.setattr(get_settings(), "run_binding_max_age_seconds", -1)
    resp = await _read(client, {**pm.headers, RUN_TOKEN_HEADER: raw, RUN_HEADER: good})
    assert resp.status_code == 400, resp.text


async def test_a_revoked_run_token_is_refused_with_or_without_a_binding(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    run_id, raw = await _run(ctx.tenant_id, pm.user_id)
    binding = sign_run_binding(pm.user_id, run_id)
    both = {**pm.headers, RUN_TOKEN_HEADER: raw, RUN_HEADER: binding}
    assert (await _read(client, both)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        assert await revoke_run_tokens(s, run_id) == 1
        await s.commit()
    assert (await _read(client, both)).status_code == 401
    # Without a binding the token is refused before it is read.
    assert (await _read(client, {**pm.headers, RUN_TOKEN_HEADER: raw})).status_code == 403
    # A made-up run token is refused the same way.
    resp = await _read(client, {**pm.headers, RUN_TOKEN_HEADER: "ort_forged", RUN_HEADER: binding})
    assert resp.status_code == 401, resp.text
