"""Section and word diff: pure unit tests plus GET /v1/documents/{doc}/diff."""

import uuid
from dataclasses import dataclass

from oracle.docs.diff import diff_sections, tokenize, word_diff
from oracle.review.models import FeedbackItem
from oracle.tenancy import tenant_session
from tests.fixtures import FEEDBACK_GUEST, FEEDBACK_SHIPPING, draft, import_draft, seed_auth

DOC = "/v1/documents/checkout-redesign"


@dataclass
class S:
    section_key: str
    ordinal: int
    heading: str = "H"
    body_text: str = "body"
    content_hash: str = "h"


def _seq(*keys: str, **hashes: str) -> list[S]:
    return [S(k, i + 1, content_hash=hashes.get(k, "h")) for i, k in enumerate(keys)]


def _summary(diffs) -> list[tuple[str, str, bool]]:
    return [(d.section_key, d.status, d.moved) for d in diffs]


def _side(ops, side: str) -> str:
    skip = "insert" if side == "from" else "delete"
    return "".join(o.text for o in ops if o.op != skip)


def _side_json(ops, side: str) -> str:
    skip = "insert" if side == "from" else "delete"
    return "".join(o["text"] for o in ops if o["op"] != skip)


def test_tokenize_round_trips():
    text = "Show an estimated cost, based on the postcode.\n\nNext  line"
    assert "".join(tokenize(text)) == text


def test_word_diff_marks_changed_words_only():
    old = "Show the shipping cost on the cart page."
    new = "Show an estimated shipping cost on the cart page."
    ops = word_diff(old, new)
    assert _side(ops, "from") == old and _side(ops, "to") == new
    assert [o.text for o in ops if o.op == "delete"] == ["the"]
    assert [o.text for o in ops if o.op == "insert"] == ["an estimated"]
    assert ops[-1].op == "equal" and ops[-1].text.endswith("cart page.")


def test_word_diff_of_equal_text_is_one_equal_op():
    assert [(o.op, o.text) for o in word_diff("a b", "a b")] == [("equal", "a b")]


def test_insertion_does_not_mark_followers_as_moved():
    diffs = diff_sections(_seq("a", "b", "c"), _seq("a", "new", "b", "c"))
    assert _summary(diffs) == [
        ("a", "unchanged", False),
        ("new", "added", False),
        ("b", "unchanged", False),
        ("c", "unchanged", False),
    ]


def test_moved_and_changed_and_removed():
    diffs = diff_sections(_seq("a", "b", "c", "d"), _seq("c", "a", "b", c="h2"))
    assert _summary(diffs) == [
        ("c", "changed", True),
        ("a", "unchanged", False),
        ("b", "unchanged", False),
        ("d", "removed", False),
    ]
    assert diffs[0].words is not None and diffs[1].words is None
    assert (diffs[0].from_ordinal, diffs[0].to_ordinal) == (3, 1)
    assert (diffs[3].from_ordinal, diffs[3].to_ordinal) == (4, None)


def test_removed_first_section_comes_first():
    assert _summary(diff_sections(_seq("x", "a"), _seq("a"))) == [
        ("x", "removed", False),
        ("a", "unchanged", False),
    ]


async def test_diff_v1_to_v2(client):
    tenant_id, auth = await seed_auth()
    v1 = (await import_draft(client, auth, draft("prd_v1.md"))).json()
    async with tenant_session(tenant_id) as s:
        for fid in (FEEDBACK_SHIPPING, FEEDBACK_GUEST):
            s.add(
                FeedbackItem(
                    id=fid,
                    document_id=uuid.UUID(v1["document_id"]),
                    raised_on_version=1,
                    kind="general",
                    summary="x",
                )
            )
        await s.commit()
    resp = await import_draft(client, auth, draft("prd_v2.md"))
    assert resp.status_code == 201
    v2 = resp.json()

    resp = await client.get(f"{DOC}/diff", params={"from": 1, "to": 2}, headers=auth)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["from_version"], body["to_version"]) == (1, 2)
    assert body["document_id"] == v1["document_id"]
    by_key = {d["section_key"]: d for d in body["sections"]}
    assert {k: d["status"] for k, d in by_key.items()} == {
        "title": "unchanged",
        "goal-trace": "changed",
        "problem": "unchanged",
        "users": "unchanged",
        "solution": "unchanged",
        "s-5-1": "unchanged",
        "s-5-2": "changed",
        "metrics": "unchanged",
        "risks": "unchanged",
        "open-questions": "removed",
        "rollout": "added",
    }
    # Risks moved ahead of metrics: exactly one of the two is flagged, not both.
    assert [k for k, d in by_key.items() if d["moved"]] == ["risks"]
    assert (by_key["risks"]["from_ordinal"], by_key["risks"]["to_ordinal"]) == (9, 8)
    # Output follows v2 order; the removed section sits after its nearest v1
    # predecessor that did not move (metrics; risks moved).
    assert [d["section_key"] for d in body["sections"]][-4:] == [
        "risks",
        "metrics",
        "open-questions",
        "rollout",
    ]

    words = by_key["s-5-2"]["words"]
    v1_sec = next(x for x in v1["sections"] if x["section_key"] == "s-5-2")
    v2_sec = next(x for x in v2["sections"] if x["section_key"] == "s-5-2")
    assert _side_json(words, "from") == f"{v1_sec['heading']}\n{v1_sec['body_text']}"
    assert _side_json(words, "to") == f"{v2_sec['heading']}\n{v2_sec['body_text']}"
    inserted = " ".join(w["text"] for w in words if w["op"] == "insert")
    deleted = " ".join(w["text"] for w in words if w["op"] == "delete")
    assert "estimated" in inserted and "postcode" in inserted
    assert "enters an address" in deleted
    # Unchanged sentences stay "equal".
    assert "Keep the address form state" in "".join(w["text"] for w in words if w["op"] == "equal")
    goal = by_key["goal-trace"]["words"]
    inserted_goal = [w["text"] for w in goal if w["op"] == "insert"]
    assert len(inserted_goal) == 1 and "and G2 (retention" in inserted_goal[0]
    assert not [w for w in goal if w["op"] == "delete"]
    assert all(d["words"] is None for d in body["sections"] if d["status"] != "changed")

    # Reverse direction swaps added/removed.
    back = (await client.get(f"{DOC}/diff", params={"from": 2, "to": 1}, headers=auth)).json()
    statuses = {d["section_key"]: d["status"] for d in back["sections"]}
    assert statuses["rollout"] == "removed" and statuses["open-questions"] == "added"


async def test_diff_same_version_and_missing_versions(client):
    _, auth = await seed_auth()
    await import_draft(client, auth, draft("prd_v1.md"))
    same = (await client.get(f"{DOC}/diff", params={"from": 1, "to": 1}, headers=auth)).json()
    assert {d["status"] for d in same["sections"]} == {"unchanged"}
    assert not any(d["moved"] for d in same["sections"])
    missing = await client.get(f"{DOC}/diff", params={"from": 1, "to": 3}, headers=auth)
    assert missing.status_code == 404
    bad = await client.get(f"{DOC}/diff", params={"from": 0, "to": 1}, headers=auth)
    assert bad.status_code == 422
