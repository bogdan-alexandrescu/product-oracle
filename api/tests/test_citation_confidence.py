"""A citation keeps what the writer computed for it (owner decision 2026-10-20): the
source item it read, its confidence 0-1 (or, when null, the note saying why) and the
low-confidence flag. Imported, stored and read back; an item the company does not have
is a warning on the version, never a refusal. Against Postgres."""

import uuid
from decimal import Decimal

from sqlalchemy import select

from oracle.docs.models import Citation
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.fixtures import draft, import_draft, seed_auth, seed_oracle_refs
from tests.sources_helpers import make_user

DOC = "/v1/documents/confidence-prd"
FIXTURE_ITEM = "3f1c2a4e-8b7d-4c1e-9a2b-5d6e7f809a1b"


async def _item(tenant_id: uuid.UUID) -> uuid.UUID:
    user = await make_user(tenant_id, f"{uuid.uuid4().hex[:8]}@example.com")
    async with tenant_session(tenant_id) as s:
        source = Source(owner_user_id=user.id, kind="github", name=uuid.uuid4().hex[:8])
        s.add(source)
        await s.flush()
        item = SourceItem(source_id=source.id, external_id="issue-12", kind="issue")
        s.add(item)
        await s.commit()
        return item.id


def _with_items(**items: str) -> str:
    """The fixture draft, c1 citing ``items['c1']``; c2 and c3 given an item when named."""
    text = draft("prd_citation_confidence.md").replace(FIXTURE_ITEM, items["c1"])
    for key in ("c2", "c3"):
        if key in items:
            ref = (
                "    ref: https://example.slack.com/archives/C123/p1700000000\n"
                if key == "c2"
                else "    ref: https://example.com/benchmarks\n"
            )
            text = text.replace(ref, f"{ref}    item: {items[key]}\n")
    return text


async def test_import_stores_and_reads_back_the_confidence_fields(client):
    tenant_id, auth = await seed_auth()
    await seed_oracle_refs(tenant_id)
    item = await _item(tenant_id)
    resp = await import_draft(client, auth, _with_items(c1=str(item)), doc="confidence-prd")
    assert resp.status_code == 201, resp.text
    v = resp.json()
    assert v["warnings"] == []
    by_key = {c["cite_key"]: c for c in v["citations"]}
    assert {
        k: (c["item_id"], c["confidence"], c["confidence_note"], c["low_confidence"])
        for k, c in by_key.items()
    } == {
        "c1": (str(item), 0.75, "two sources agree; fresh", False),
        "c2": (None, 0.3, "one mention, 9 months old", True),
        "o-d-ship": (
            None,
            None,
            "owner decision (confirmed, locked); not evidence-scored",
            False,
        ),
        "c3": (None, None, None, False),
    }

    # The read API returns the same.
    read = (await client.get(f"{DOC}/versions/1", headers=auth)).json()
    assert read["citations"] == v["citations"]

    async with tenant_session(tenant_id) as s:
        c1 = await s.scalar(select(Citation).where(Citation.cite_key == "c1"))
    assert (c1.item_id, c1.confidence, c1.low_confidence) == (item, Decimal("0.750"), False)


async def test_round_trip_through_the_markdown_export(client):
    # The stored markdown carries the fields; re-importing it is the same version.
    tenant_id, auth = await seed_auth()
    await seed_oracle_refs(tenant_id)
    text = _with_items(c1=str(await _item(tenant_id)))
    created = (await import_draft(client, auth, text, doc="confidence-prd")).json()
    md = (await client.get(f"{DOC}/versions/1/markdown", headers=auth)).text
    again = await import_draft(client, auth, md, doc="confidence-prd")
    assert again.status_code == 200, again.text
    assert again.json()["id"] == created["id"]
    assert again.json()["citations"] == created["citations"]


async def test_an_unknown_or_other_company_item_is_a_warning_not_a_refusal(client):
    tenant_id, auth = await seed_auth()
    await seed_oracle_refs(tenant_id)
    other = await _item(await make_tenant("Other Co"))
    unknown = uuid.uuid4()
    resp = await import_draft(
        client,
        auth,
        _with_items(c1=str(other), c2=str(unknown), c3="not-a-uuid"),
        doc="confidence-prd",
    )
    assert resp.status_code == 201, resp.text
    v = resp.json()
    # Imported; each such citation keeps everything but the item.
    by_key = {c["cite_key"]: c for c in v["citations"]}
    assert [by_key[k]["item_id"] for k in ("c1", "c2", "c3")] == [None, None, None]
    assert by_key["c1"]["confidence"] == 0.75
    warnings = [w for w in v["warnings"] if w["code"] == "unknown_citation_item"]
    assert len(warnings) == 3
    # #396: a person reads "a source item Oracle no longer has"; agents get the ids in refs.
    assert {(w["refs"]["cite_key"], w["refs"]["source_item"]) for w in warnings} == {
        ("c1", str(other)),
        ("c2", str(unknown)),
        ("c3", "not-a-uuid"),
    }
    for w in warnings:
        assert "a source item Oracle no longer has" in w["message"]
        assert str(other) not in w["message"] and str(unknown) not in w["message"]
    # The warning names the sections citing it.
    assert {tuple(w["section_keys"]) for w in warnings} == {("problem",), ("decisions",)}

    async with tenant_session(tenant_id) as s:
        stored = list(await s.scalars(select(Citation.item_id)))
    assert stored == [None] * 4
