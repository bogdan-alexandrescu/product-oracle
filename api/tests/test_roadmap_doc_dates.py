"""O4 'document dates' (owner, 2026-10-19): the verified-basis rule covers dates written
in the roadmap document's text. On import a date must match a verified basis of the
roadmap's PRD (and its item or tracker key when the basis names one): a person's import
is refused, a run's import marks the date 'unverified' and records the problem. A
withdrawn basis marks the approved version's dates 'date withdrawn' in the document
view, Present and the exports, without rewriting the approved text. Against Postgres
with the FakeRuntime."""

from datetime import date

from oracle.roadmap import doc_dates
from oracle.swarm import Outcome
from tests.fixtures import import_draft
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    ROADMAP,
    ROADMAP_MD,
    approved_prd,
    built_roadmap,
    create,
    get,
    owner,
    runtime,
    start,
    tick,
)
from tests.test_tracks import track_of

VERSIONS = f"/v1/documents/{ROADMAP}/versions"
BETA = "Beta by 2026-11-30."


def with_line(line: str, section: str = "now-payment-step", md: str = ROADMAP_MD) -> str:
    """ROADMAP_MD with ``line`` added to the end of a section's first paragraph."""
    heading = {
        "now-payment-step": "### Payment step {#now-payment-step}\n\n",
        "next-shipping-step": "### Shipping step {#next-shipping-step}\n\n",
        "summary": "## Summary {#summary}\n\n",
    }[section]
    assert heading in md
    return md.replace(heading, heading + line + "\n", 1)


async def record(client, auth, reference: str, day: str, **scope) -> dict:
    resp = await client.post(
        "/v1/schedule-bases",
        json={"kind": "estimate", "reference": reference, "supports_date": day, "prd": PRD,
              **scope},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    return resp.json()


async def push(client, auth, markdown: str, doc: str = ROADMAP):
    return await import_draft(client, auth, markdown, doc)


def _codes(resp) -> list[str]:
    return [p["code"] for p in resp.json()["errors"]]


# --------------------------------------------------------------------------- finding


def test_dates_are_found_in_the_text_not_in_sources_links_or_horizons():
    found = doc_dates.dates_in(
        "Beta 2026-11-30, GA Dec 15, 2026 and 3rd January 2027; not 2026-13-01, "
        "Q4 2026, November 2026 or ENG-2026-11-30"
    )
    assert [(t, d) for t, d, _ in found] == [
        ("2026-11-30", date(2026, 11, 30)),
        ("Dec 15, 2026", date(2026, 12, 15)),
        ("3rd January 2027", date(2027, 1, 3)),
        # Round 4: a date a reader sees is a date, even after a key and a hyphen.
        ("2026-11-30", date(2026, 11, 30)),
    ]
    md = with_line("See [the plan](https://example.com/2026-12-01/plan).")
    md = md.replace("- Beta date: ENG-412 estimate [c:c1]", "- Retrieved 2026-10-01 [c:c1]")
    from oracle.docs.parser import parse_draft

    found = doc_dates.find(parse_draft(md).sections)
    assert [(f.section_key, f.text) for f in found] == [("now-payment-step", "2026-11-30")]


# --------------------------------------------------------------------------- import


async def test_a_person_s_import_refuses_an_unverified_date(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)

    # A date no basis of the PRD supports.
    resp = await push(client, auth, with_line("GA on 2026-12-15."))
    assert resp.status_code == 422, resp.text
    assert _codes(resp) == ["unverified_date"]
    (problem,) = resp.json()["errors"]
    assert problem["section_key"] == "now-payment-step" and "Dec 15, 2026" in problem["message"]
    # Written another way, still a date.
    resp = await push(client, auth, with_line("GA on December 15, 2026."))
    assert resp.status_code == 422 and _codes(resp) == ["unverified_date"]

    # A basis for another item supports the date only where that item is named.
    await record(client, auth, "ENG-500", "2026-12-15", item_key="shipping-step")
    resp = await push(client, auth, with_line("GA on 2026-12-15."))
    assert resp.status_code == 422 and _codes(resp) == ["unverified_date"]
    resp = await push(client, auth, with_line("Ships 2026-12-15 (ENG-500).", "next-shipping-step"))
    assert resp.status_code == 201, resp.text

    # A tracker-key basis: where the tracker issue or the items it is matched to are named.
    track = await track_of(client, auth)
    resp = await client.post(
        "/v1/tracker/records",
        json={"tracker": "jira", "records": [
            {"external_ref": "ENG-600", "state": "todo", "track_id": track["id"],
             "item_key": "payment-step"}]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    await record(client, auth, "CAP-7", "2027-01-15", tracker_key="ENG-600")
    resp = await push(client, auth, with_line("Capacity frees on 2027-01-15.", "summary"))
    assert resp.status_code == 422 and _codes(resp) == ["unverified_date"]
    resp = await push(client, auth, with_line("Hardening done 2027-01-15."))
    assert resp.status_code == 201, resp.text


async def test_a_manual_roadmap_without_a_prd_refuses_any_date(client, owner):  # noqa: F811
    _, auth = owner
    md = ROADMAP_MD.replace("document: checkout-redesign-roadmap", "document: loose-roadmap")
    # No PRD of its own (no provenance, no track, no ``prd:``): a PRD its text links to
    # is not its PRD.
    md = md.replace("prd: {document: checkout-redesign, version: 1}\n", "")
    assert "/documents/checkout-redesign/v/1" in md
    resp = await push(client, auth, md, "loose-roadmap")
    assert resp.status_code == 422 and _codes(resp) == ["unverified_date"]
    assert "none is known" in resp.json()["errors"][0]["message"]
    # Without dates it imports.
    resp = await push(
        client, auth, md.replace("Beta by 2026-11-30.", "Beta first."), "loose-roadmap"
    )
    assert resp.status_code == 201, resp.text


async def test_a_run_s_import_marks_an_unverified_date(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    from tests.test_roadmap import ITEMS

    runtime.script["roadmap_items"] = [Outcome(artifacts={"roadmap_items.yaml": ITEMS})]
    runtime.script["roadmap_draft"] = [
        Outcome(artifacts={"roadmap.md": with_line("GA on 2026-12-15.")})
    ]
    off = {"roadmap_items": False, "roadmap_review": False}
    run = await start(
        client, auth, await create(client, auth, source=PRD, knobs={"checkpoints": off})
    )
    await tick(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "succeeded", run
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    warnings = [w for w in version["warnings"] if w["code"] == "unverified_date"]
    assert len(warnings) == 1 and "Dec 15, 2026" in warnings[0]["message"]
    assert warnings[0]["section_keys"] == ["now-payment-step"]
    marks = {(m["text"], m["status"], m["label"]) for m in version["date_marks"]}
    assert marks == {("2026-11-30", "verified", None), ("2026-12-15", "unverified", "unverified")}
    # The text is stored as written; the markdown carries a comment after the date.
    md = (await client.get(f"{VERSIONS}/1/markdown", headers=auth)).text
    assert "GA on 2026-12-15 <!-- oracle: date unverified -->." in md
    assert "2026-11-30 <!--" not in md


# --------------------------------------------------------------------------- withdrawal


async def test_a_withdrawn_basis_marks_the_approved_version_s_dates(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    before = (await client.get(f"{VERSIONS}/1/markdown", headers=auth)).text
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    assert [(m["text"], m["status"]) for m in version["date_marks"]] == [("2026-11-30", "verified")]

    (eng,) = [
        b
        for b in (await client.get("/v1/schedule-bases", headers=auth)).json()
        if b["reference"] == "ENG-412"
    ]
    resp = await client.post(
        f"/v1/schedule-bases/{eng['id']}/withdraw", json={"reason": "re-estimated"}, headers=auth
    )
    assert resp.status_code == 200, resp.text

    # The document view.
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    assert version["date_marks"] == [
        {"section_key": "now-payment-step", "text": "2026-11-30", "date": "2026-11-30",
         "status": "withdrawn", "label": "date withdrawn", "bases": ["ENG-412"],
         "where": "body"}
    ]  # fmt: skip
    # The approved text is not rewritten: the markdown carries a comment after the date,
    # which an import drops.
    after = (await client.get(f"{VERSIONS}/1/markdown", headers=auth)).text
    assert after == before.replace("2026-11-30.", "2026-11-30 <!-- oracle: date withdrawn -->.")
    assert BETA in before
    # Exports: HTML (and the PDF built from it), the themed full and brief layers.
    url = f"{VERSIONS}/1/export"
    for layer in ("full",):
        html = (await client.get(url, params={"format": "html", "layer": layer}, headers=auth)).text
        assert "2026-11-30 <strong>[date withdrawn]</strong>" in html, layer
    # Present and the slide export: the deck.
    deck = (await client.get(f"{VERSIONS}/1/deck", headers=auth)).json()
    text = " ".join(s["html"] for s in deck["slides"]) + " ".join(
        e["html"] for s in deck["slides"] for e in s["expand"]
    )
    assert "2026-11-30 <strong>[date withdrawn]</strong>" in text
    # The markdown export is the stored text (a copy for editing) with the comment.
    md = (await client.get(url, params={"format": "md"}, headers=auth)).text
    assert "[date withdrawn]" not in md
    assert "Beta by 2026-11-30 <!-- oracle: date withdrawn -->." in md

    # A new verified basis for the date: the marker goes.
    await record(client, auth, "ENG-412", "2026-11-30")
    version = (await client.get(f"{VERSIONS}/1", headers=auth)).json()
    assert [m["status"] for m in version["date_marks"]] == ["verified"]
