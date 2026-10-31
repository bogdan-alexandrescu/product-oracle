"""qa4-docs-39: a feedback item carries its author's name, so every reader of the review
panel (not only the author) sees who raised it, never a bare initial."""

from sqlalchemy import select

from oracle.auth.models import User
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_runs import as_user

SLUG = "checkout-redesign"


async def test_the_feedback_list_names_each_items_author(client):
    tenant_id, auth = await seed_auth()
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    commenter = await as_user(tenant_id, "commenter", "dana.reyes@example.com")
    named = await as_user(tenant_id, "commenter", "pat@example.com")
    async with tenant_session(tenant_id) as s:
        user = await s.scalar(select(User).where(User.email == "pat@example.com"))
        user.name = "Pat Lindqvist"
        await s.commit()
    viewer = await as_user(tenant_id, "viewer")

    resp = await client.post(
        f"/v1/documents/{SLUG}/versions/1/comments",
        json={
            "section_key": "problem",
            "anchor": {"exact": "Too many shoppers"},
            "body": "How many?",
        },
        headers=commenter,
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(
        f"/v1/documents/{SLUG}/versions/1/feedback",
        json={"body": "Add a rollout section."},
        headers=named,
    )
    assert resp.status_code == 201, resp.text
    # The item as created names its author too.
    assert resp.json()["author_name"] == "Pat Lindqvist"

    listed = await client.get(f"/v1/documents/{SLUG}/feedback", headers=viewer)

    assert listed.status_code == 200, listed.text
    by_summary = {i["summary"]: i["author_name"] for i in listed.json()}
    # Named from the email when the member has no name; their own name when set.
    assert by_summary == {"How many?": "Dana Reyes", "Add a rollout section.": "Pat Lindqvist"}
