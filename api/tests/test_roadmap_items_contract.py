"""E2 Items tab: the contract between the web's roadmap items fixture and the API.

The mock's roadmap-items scenario serves web/lib/api/mock/roadmap-items.json (the items
the Items tab is proven on). This test keeps that fixture honest: it validates against
``RoadmapItemOut``, and the same items, imported through the real API, come back from
``GET /v1/roadmaps/{doc}/items?view=full`` with every field the tab reads present and of
the same JSON type. A field renamed on either side fails it.

protects: the mock's item shape is the API's; fails_when: a field the tab reads is
renamed, dropped or retyped on either side; no_claim: the values the real API computes
(staleness, live dates: tests/test_roadmap_items.py, test_roadmap_dates.py)."""

import json
from pathlib import Path
from typing import Any

import yaml

from oracle.roadmap.schemas import RoadmapItemOut
from tests.test_roadmap import (  # noqa: F401 - fixtures
    ROADMAP,
    approved_prd,
    built_roadmap,
    owner,
    runtime,
)

FIXTURE = Path(__file__).resolve().parents[2] / "web/lib/api/mock/roadmap-items.json"

# Every field the Items tab reads (web/components/roadmap/item-row.ts and the inspector),
# as dotted paths into one item.
TAB_FIELDS = [
    "id",
    "item_key",
    "position",
    "title",
    "outcome",
    "horizon",
    "milestone",
    "milestone.name",
    "milestone.date",
    "milestone.date_source",
    "milestone.basis_ids",
    "freshness",
    "stale_reasons",
    "stale_since",
    "prd",
    "prd.document",
    "prd.document.slug",
    "prd.document.title",
    "prd.document.version",
    "prd.section_key",
    "prd.link",
    "prd.reconciled_version",
    "feature",
    "requirements",
    "blockers",
    "depends_on",
    "validation_gates",
    "priority",
    "priority.rank",
    "priority.score",
    "priority.explanation",
    "confidence",
    "engineering",
]

# The checkout PRD the API tests build from has its sections as s-5-1, s-5-2.
PRD_SECTIONS = {"behaviour": "s-5-1", "metrics": "s-5-2"}


def _fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text())


def _items_yaml(items: list[dict[str, Any]]) -> str:
    """The fixture's items as a roadmap_items.yaml the import route takes."""
    out = []
    for i in items:
        row: dict[str, Any] = {
            "id": i["item_key"],
            "title": i["title"],
            "outcome": i["outcome"],
            "horizon": i["horizon"],
            "depends_on": i["depends_on"],
            "priority": i["priority"],
            "confidence": i["confidence"],
            "prd_section": PRD_SECTIONS[i["prd"]["section_key"]],
        }
        if i["milestone"]:
            m = i["milestone"]
            row["milestone"] = {k: m[k] for k in ("name", "date", "date_source") if m.get(k)}
        out.append(row)
    doc = {"version": 1, "prd": {"document": "checkout-redesign", "version": 1}, "items": out}
    return yaml.safe_dump(doc, sort_keys=False)


_MISSING = object()


def _at(item: dict[str, Any], path: str) -> Any:
    value: Any = item
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return _MISSING
        value = value[part]
    return value


def _kind(value: Any) -> str:
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    return type(value).__name__


def test_the_fixture_is_roadmap_item_out():
    fixture = _fixture()
    assert fixture["roadmap"] == "usage-alerts-roadmap" and fixture["version"] == 1
    assert [i["item_key"] for i in fixture["items"]] == ["item-behaviour", "item-metrics"]
    for item in fixture["items"]:
        out = RoadmapItemOut.model_validate(item)
        # Nothing in the fixture the API's model does not have.
        assert set(item) == set(out.model_dump()), set(item) ^ set(out.model_dump())
        for path in TAB_FIELDS:
            assert _at(item, path) is not _MISSING or "." in path, path


async def test_the_real_items_route_serves_the_fixtures_fields(client, owner, runtime):  # noqa: F811
    _, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    fixture = _fixture()["items"]
    resp = await client.put(
        f"/v1/roadmaps/{ROADMAP}/versions/1/items",
        json={"yaml": _items_yaml(fixture)},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    real = (
        await client.get(f"/v1/roadmaps/{ROADMAP}/items", params={"view": "full"}, headers=auth)
    ).json()["items"]
    assert [i["item_key"] for i in real] == [i["item_key"] for i in fixture]

    for mock_item, real_item in zip(fixture, real, strict=True):
        RoadmapItemOut.model_validate(real_item)
        for path in TAB_FIELDS:
            want, got = _at(mock_item, path), _at(real_item, path)
            # A nested field under a null parent is absent on both sides alike.
            assert (want is _MISSING) == (got is _MISSING), (mock_item["item_key"], path)
            if want is _MISSING or want is None or got is None:
                continue
            assert _kind(want) == _kind(got), (mock_item["item_key"], path, want, got)
            if isinstance(want, list) and want and got:
                assert _kind(want[0]) == _kind(got[0]), (mock_item["item_key"], path)
        # The values the tab shows from the imported fields are the fixture's.
        for path in ("title", "outcome", "horizon", "confidence", "depends_on", "priority"):
            assert _at(real_item, path) == _at(mock_item, path), path
        if mock_item["milestone"]:
            assert real_item["milestone"]["date"] == mock_item["milestone"]["date"]
            assert len(real_item["milestone"]["basis_ids"]) == 1
