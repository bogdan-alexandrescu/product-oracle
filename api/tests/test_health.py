async def test_healthz_checks_database(client):
    """The health check reports the database is reachable, not just the app is up."""
    r = await client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "database": "ok"}


# #1569: the commit each image was built from (api/Dockerfile's GIT_SHA build argument),
# served without signing in, so a deploy can check what is serving.
async def test_version_serves_the_build_commit_without_signing_in(client, monkeypatch):
    """The version endpoint serves the build's commit hash without signing in."""
    monkeypatch.setenv("ORACLE_GIT_SHA", "0123456789abcdef0123456789abcdef01234567")
    r = await client.get("/version")
    assert r.status_code == 200
    assert r.json() == {"git_sha": "0123456789abcdef0123456789abcdef01234567"}


async def test_version_without_a_stamp_says_unknown(client, monkeypatch):
    """With no build stamp set, the version endpoint reports unknown, not failing."""
    monkeypatch.delenv("ORACLE_GIT_SHA", raising=False)
    r = await client.get("/version")
    assert r.status_code == 200
    assert r.json() == {"git_sha": "unknown"}


# #1710: the load balancer sends only /v1/* and /healthz to the API, so its commit is served
# under /v1 as well, for the deploy's containment check (ORACLE_API_VERSION_URL).
async def test_version_is_served_under_v1_without_signing_in(client, monkeypatch):
    """The API's commit is reachable at /v1/version, where the load balancer routes it."""
    monkeypatch.setenv("ORACLE_GIT_SHA", "0123456789abcdef0123456789abcdef01234567")
    r = await client.get("/v1/version")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    assert r.json() == {"git_sha": "0123456789abcdef0123456789abcdef01234567"}
