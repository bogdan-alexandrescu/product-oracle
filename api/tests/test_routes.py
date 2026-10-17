"""Every endpoint of docs/mvp-app.md 'REST API' exists and requires auth.

Stubs answer 501 until their lane lands; this test stays valid after that.
"""

import uuid

import pytest

from oracle.main import app

V = "/v1/documents/{doc}/versions/{n}"
SPEC_ROUTES = [
    ("POST", "/v1/auth/login"),
    ("POST", "/v1/auth/logout"),
    ("GET", "/v1/me"),
    ("GET", "/v1/documents"),
    ("GET", "/v1/documents/{doc}"),
    ("POST", "/v1/documents/{doc}/versions"),
    ("GET", "/v1/documents/{doc}/versions"),
    ("GET", V),
    ("GET", V + "/markdown"),
    ("GET", "/v1/documents/{doc}/diff"),
    ("POST", V + "/comments"),
    ("GET", V + "/comments"),
    ("POST", "/v1/comments/{comment_id}/replies"),
    ("PATCH", "/v1/comments/{comment_id}"),
    ("PUT", V + "/sections/{key}/review"),
    ("GET", "/v1/documents/{doc}/feedback"),
    ("PATCH", "/v1/feedback/{feedback_id}"),
    ("GET", V + "/feedback-package"),
    ("GET", V + "/resolution-report"),
    ("POST", V + "/approve"),
    ("GET", V + "/export"),
    ("GET", "/healthz"),
]
PUBLIC = {("POST", "/v1/auth/login"), ("POST", "/v1/auth/logout"), ("GET", "/healthz")}


def _concrete(path: str) -> str:
    return path.format(
        doc="example-doc", n=1, key="goal-trace", comment_id=uuid.uuid4(), feedback_id=uuid.uuid4()
    )


def test_openapi_has_every_spec_route():
    paths = app.openapi()["paths"]
    for method, path in SPEC_ROUTES:
        assert method.lower() in paths.get(path, {}), f"{method} {path} missing"


@pytest.mark.parametrize(("method", "path"), [r for r in SPEC_ROUTES if r not in PUBLIC])
async def test_protected_routes_require_auth(client, method, path):
    resp = await client.request(method, _concrete(path))
    assert resp.status_code == 401
