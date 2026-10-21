"""Shared setup for the specs lane tests (oracle/specs): an approved PRD whose sections link
two baseline requirements (one verified by an acceptance criterion), the agents' spec.md
and design.json, and the run steps. Synthetic placeholders only."""

import json
import uuid
from dataclasses import dataclass

from sqlalchemy import select

from oracle.auth.models import User
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.tenancy import tenant_session
from oracle.v2.models import DocumentSectionLink
from tests.baseline_helpers import Ctx, make_ctx
from tests.fixtures import draft

PRD = "checkout-redesign"
MARKDOWN = {"Content-Type": "text/markdown"}

SPEC_SECTIONS = (
    ("summary", "Summary", "Shoppers see the shipping cost on the cart page."),
    ("approach", "Proposed engineering approach", "A shipping quote service called from the cart."),
    ("open-decisions", "Open engineering decisions", "Which carrier rates to cache."),
    ("acceptance-criteria", "Acceptance criteria", "- The quote refreshes when the cart changes."),
    ("user-flows", "User flows", "Cart, then quote, then shipping step."),
    ("inputs-outputs", "Inputs and outputs", "Cart lines and a postcode in; a quote out."),
    ("architecture", "Proposed architecture", "A quote endpoint in front of the carrier adapter."),
    ("apis-data", "APIs and data models", "GET /quotes?cart=... returns amount and currency."),
    ("dependencies", "Dependencies", "The carrier adapter."),
    ("failure-modes", "Failure modes", "No quote: show the range instead."),
    ("security-privacy-performance", "Security, privacy and performance", "Postcodes only."),
    ("test-strategy", "Test strategy", "Contract tests on the quote endpoint."),
    ("release-flags", "Release flags", "cart_shipping_quote, off by default."),
    ("migration-rollback", "Migration and rollback", "No migration; turn the flag off."),
    ("assumptions", "Assumptions", "The cart service can call an internal endpoint."),
)  # fmt: skip


def spec_md(skip: tuple[str, ...] = (), extra: str = "") -> str:
    parts = [
        f"## {title} {{#{key}}}\n\n{body}" for key, title, body in SPEC_SECTIONS if key not in skip
    ]
    return "---\ntitle: ignored\n---\n\n" + "\n\n".join(parts) + "\n" + extra


FLOW_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100">'
    '<defs><marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">'
    '<path d="M0,0 L6,3 L0,6 z" fill="#333"/></marker></defs>'
    '<rect id="cart" x="10" y="30" width="110" height="40" fill="#eee" stroke="#333"/>'
    '<text x="65" y="55" text-anchor="middle">Cart</text>'
    '<rect id="quote" x="150" y="30" width="110" height="40" fill="#eee" stroke="#333"/>'
    '<text x="205" y="55" text-anchor="middle">Shipping quote</text>'
    '<line x1="120" y1="50" x2="150" y2="50" stroke="#333" marker-end="url(#arrow)"/>'
    "</svg>"
)


def wireframe_html(n: int) -> str:
    return (
        "<!doctype html><html><head><title>x</title><style>.box{border:1px solid #999}</style>"
        f'</head><body><h1 id="heading-{n}">Cart {n}</h1>'
        '<div class="box" data-annotation="cost">Shipping: $4.99 (mocked)</div>'
        '<label for="pc">Postcode</label><input id="pc" type="text" placeholder="Postcode">'
        "<button>Continue</button></body></html>"
    )


def design_json(reqs: list[str], sections: list[str], screens: int = 3, **override) -> str:
    note = {
        "id": "cost-early",
        "target": "quote",
        "note": "The quote shows before the address step.",
        "section_key": sections[0],
        "requirement_ids": reqs[:1],
    }
    bundle = {
        "version": 1,
        "flows": [
            {
                "name": "checkout-flow.svg",
                "title": "Checkout with an early quote",
                "svg": FLOW_SVG,
                "section_keys": sections,
                "requirement_ids": reqs,
                "annotations": [note],
            }
        ],
        "wireframes": [
            {
                "name": f"cart-{n}.html",
                "title": f"Cart {n}",
                "screen": f"cart-{n}",
                "html": wireframe_html(n),
                "section_keys": sections[:1],
                "requirement_ids": reqs[:1],
                "annotations": [{**note, "id": "cost-label", "target": "cost"}],
            }
            for n in range(1, screens + 1)
        ],
    }
    bundle.update(override)
    return json.dumps(bundle)


@dataclass
class World:
    ctx: Ctx
    prd_id: uuid.UUID
    prd_v1: uuid.UUID
    shipping: uuid.UUID  # requirement linked to s-5-2
    cards: uuid.UUID  # requirement linked to s-5-1
    criterion: uuid.UUID
    feature: uuid.UUID

    @property
    def reqs(self) -> list[str]:
        return [str(self.shipping), str(self.cards)]


async def import_md(client, headers, text: str, doc: str = PRD):
    return await client.post(
        f"/v1/documents/{doc}/versions", content=text.encode(), headers={**headers, **MARKDOWN}
    )


async def make_world(client, name: str = "Example Co", approve: bool = True) -> World:
    ctx = await make_ctx(name)
    owner = ctx.as_("owner")
    resp = await import_md(client, owner, draft("prd_v1.md"))
    assert resp.status_code == 201, resp.text
    if approve:
        resp = await client.post(f"/v1/documents/{PRD}/versions/1/approve", headers=owner)
        assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == PRD))
        v1 = await s.scalar(
            select(DocumentVersion).where(
                DocumentVersion.document_id == doc.id, DocumentVersion.number == 1
            )
        )
        feature = Entity(
            type="feature", key="early-shipping-cost", title="Early shipping cost",
            status="confirmed", origin="user",
        )  # fmt: skip
        shipping = Entity(
            type="requirement", key="req-shipping-cost", title="Show shipping cost on the cart",
            body="The cart shows the shipping cost before the address step.",
            status="confirmed", origin="user",
        )  # fmt: skip
        cards = Entity(
            type="requirement", key="req-saved-cards", title="Saved cards first",
            status="confirmed", origin="user",
        )  # fmt: skip
        criterion = Entity(
            type="acceptance_criterion", key="ac-cost-visible",
            title="A shopper sees the shipping cost without entering an address",
            status="confirmed", origin="user",
        )  # fmt: skip
        s.add_all([feature, shipping, cards, criterion])
        await s.flush()
        s.add_all(
            [
                Edge(src_id=criterion.id, dst_id=shipping.id, type="verifies",
                     status="confirmed", origin="user"),
                DocumentSectionLink(document_id=doc.id, version_id=v1.id, section_key="s-5-2",
                                    kind="implements", entity_id=shipping.id),
                DocumentSectionLink(document_id=doc.id, version_id=v1.id, section_key="s-5-1",
                                    kind="implements", entity_id=cards.id),
            ]
        )  # fmt: skip
        await s.commit()
        return World(ctx, doc.id, v1.id, shipping.id, cards.id, criterion.id, feature.id)


async def adopt(world: World, number: int) -> None:
    """PRD version ``number`` adopts both requirements (E1: a section link on it), as the
    fixture's v1 does; links made without a section hash are not carried forward."""
    async with tenant_session(world.ctx.tenant_id) as s:
        version_id = await s.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == world.prd_id, DocumentVersion.number == number
            )
        )
        s.add_all(
            [
                DocumentSectionLink(document_id=world.prd_id, version_id=version_id,
                                    section_key="s-5-2", kind="implements",
                                    entity_id=world.shipping),
                DocumentSectionLink(document_id=world.prd_id, version_id=version_id,
                                    section_key="s-5-1", kind="implements", entity_id=world.cards),
            ]
        )  # fmt: skip
        await s.commit()


async def add_approver(ctx: Ctx, email: str = "eng-lead@example.com") -> User:
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email=email, password_hash="x", role="approver")
        s.add(user)
        await s.commit()
        ctx.users[email] = user
        return user


async def request_spec(client, world: World, who: str = "approver", status=201, **body):
    payload = {
        "prd": PRD,
        "requirement_ids": world.reqs,
        "feature_id": str(world.feature),
        **body,
    }
    resp = await client.post("/v1/spec-requests", json=payload, headers=world.ctx.as_(who))
    assert resp.status_code == status, resp.text
    return resp.json()


async def start(client, headers, run_id) -> dict:
    est = await client.post(f"/v1/runs/{run_id}/estimate", headers=headers)
    assert est.status_code == 200, est.text
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def tick(client, headers) -> None:
    resp = await client.post("/v1/internal/tick", headers=headers)
    assert resp.status_code == 200 and resp.json()["errors"] == [], resp.text


async def get_run(client, headers, run_id) -> dict:
    resp = await client.get(f"/v1/runs/{run_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def get_spec(client, headers, request_id) -> dict:
    resp = await client.get(f"/v1/spec-requests/{request_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def pending(run: dict) -> dict:
    return next(c for c in run["checkpoints"] if c["status"] == "pending")
