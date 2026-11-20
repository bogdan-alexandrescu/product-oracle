async def test_healthz_checks_database(client):
    r = await client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "database": "ok"}


# #1569: the commit each image was built from (api/Dockerfile's GIT_SHA build argument),
# served without signing in, so a deploy can check what is serving.
async def test_version_serves_the_build_commit_without_signing_in(client, monkeypatch):
    monkeypatch.setenv("ORACLE_GIT_SHA", "0123456789abcdef0123456789abcdef01234567")
    r = await client.get("/version")
    assert r.status_code == 200
    assert r.json() == {"git_sha": "0123456789abcdef0123456789abcdef01234567"}


async def test_version_without_a_stamp_says_unknown(client, monkeypatch):
    monkeypatch.delenv("ORACLE_GIT_SHA", raising=False)
    r = await client.get("/version")
    assert r.status_code == 200
    assert r.json() == {"git_sha": "unknown"}
