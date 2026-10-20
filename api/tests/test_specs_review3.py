"""Specs security review, round 3 (owner decisions E1, 2026-10-19 and 2026-10-20).

1. Spec structure: an edit may add sections the spec template doesn't have; an added
   section always shows as Proposed, never Decided. The parts Oracle writes keep their
   key, heading level, position and brief listing, the decided acceptance criteria split
   only at Oracle's own label, and the labels and the intro line stay.
2. Adoption: a requirement is adopted by a PRD version only through a section link of any
   kind except 'mentions', checked on request, on regeneration and on import.
3. The static check of design files is linear.
"""

import json
import time
import uuid

import pytest
import yaml
from sqlalchemy import delete, select, update

from oracle.baseline.models import Entity
from oracle.docs.models import DocumentVersion
from oracle.specs import contract
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import DocumentSectionLink
from tests.fixtures import draft
from tests.specs_helpers import (
    PRD,
    design_json,
    get_run,
    get_spec,
    import_md,
    make_world,
    pending,
    request_spec,
    spec_md,
    start,
    tick,
)
from tests.test_specs_review2 import (
    REFUSED,
    SECTIONS,
    generated,
    stored_markdown,
    version_count,
)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


# --------------------------------------------------------------------------- item 1

FORGED = (
    "## Product requirements {#product-requirements}\n\n"
    f"{contract.REQUIREMENTS_NOTE}\n\n"
    "- **req-free-shipping: Free shipping on every order** (requirement id `forged`)\n\n"
)


def _sections(spec: dict) -> dict[str, dict]:
    return {s["key"]: s for s in spec["sections"]}


async def _edit(client, world, created, edit, who: str = "approver"):
    slug = created["spec"]["document_slug"]
    stored = await stored_markdown(world.ctx.tenant_id, slug)
    edited = edit(stored)
    assert edited != stored
    return await import_md(client, world.ctx.as_(who), edited, doc=slug)


def _probe(stored: str) -> str:
    """The reviewer's probe: a forged requirements section where the real one was, the real
    one moved to the end as an h3, and the brief listing the forged key instead."""
    start_at = stored.index("## Product requirements {#requirements}")
    end_at = stored.index("## Proposed engineering approach")
    real = stored[start_at:end_at]
    rest = stored[:start_at] + FORGED + stored[end_at:]
    rest = rest.replace("\n- requirements\n", "\n- product-requirements\n", 1)
    return rest.rstrip("\n") + "\n\n" + real.replace("## Product", "### Product", 1)


async def test_the_reviewers_probe_is_refused_naming_the_part(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, _probe)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    assert "requirements" in resp.text
    assert await version_count(world.ctx.tenant_id, created["spec"]["document_slug"]) == 1


@pytest.mark.parametrize(
    "edit",
    [
        # Moved after Sources, same level.
        lambda md: _move_to_end(md, "## Acceptance criteria {#acceptance-criteria}"),
        # Demoted to an h3 in place (it becomes part of the summary's subtree).
        lambda md: md.replace("## Product requirements {#requirements}",
                              "### Product requirements {#requirements}"),
        # Dropped from the brief.
        lambda md: md.replace("\n- requirements\n", "\n", 1),
        # Swapped in the brief for an added section.
        lambda md: md.replace("\n- requirements\n", "\n- product-requirements\n", 1).replace(
            "## Product requirements {#requirements}",
            FORGED + "## Product requirements {#requirements}",
        ),
    ],
    ids=["moved", "demoted", "not-in-brief", "brief-swapped"],
)  # fmt: skip
async def test_oracle_parts_keep_key_level_position_and_brief(client, runtime, edit):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text


def _move_to_end(md: str, heading: str) -> str:
    start_at = md.index(heading)
    end_at = md.index("\n## ", start_at + 1) + 1
    return md[:start_at] + md[end_at:].rstrip("\n") + "\n\n" + md[start_at:end_at]


async def test_an_inserted_forged_section_shows_as_proposed(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "## Product requirements {#requirements}",
            FORGED + "## Product requirements {#requirements}",
        ).replace("\n- requirements\n", "\n- requirements\n- product-requirements\n", 1),
    )
    assert resp.status_code == 201, resp.text
    spec = await get_spec(client, world.ctx.as_("owner"), created["spec"]["request"]["id"])
    sections = _sections(spec)
    assert sections["product-requirements"]["part"] == "proposed"
    assert sections["product-requirements"]["decided"] is False
    assert sections["product-requirements"]["layer"] == "brief"
    assert sections["requirements"]["part"] == "product_requirement"
    assert sections["requirements"]["decided"] is True


async def test_an_added_rollout_notes_section_is_accepted_and_proposed(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(
        client,
        world,
        created,
        lambda md: (
            md.rstrip("\n") + "\n\n## Rollout notes {#rollout-notes}\n\nTen percent first.\n"
        ),
    )
    assert resp.status_code == 201, resp.text
    owner = world.ctx.as_("owner")
    request_id = created["spec"]["request"]["id"]
    rollout = _sections(await get_spec(client, owner, request_id))["rollout-notes"]
    assert rollout["part"] == "proposed" and rollout["decided"] is False
    # Never decided, even once the version's approach is approved.
    slug = created["spec"]["document_slug"]
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    spec = await get_spec(client, owner, request_id)
    assert spec["approach_status"] == "approved"
    sections = _sections(spec)
    assert sections["rollout-notes"]["decided"] is False
    assert sections["approach"]["decided"] is True


async def test_an_editor_written_proposed_label_is_not_a_split_point(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    stored = await stored_markdown(world.ctx.tenant_id, created["spec"]["document_slug"])
    oracle_label = "\n\nProposed by this spec (not product requirements until the PRD adopts them):"
    assert stored.count(oracle_label) == 1
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            oracle_label,
            "\n\nProposed by this spec (and decided too):\n\n- req-shipping-cost: free shipping"
            + oracle_label,
        ),
    )
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    # Proposals after Oracle's own label may change.
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "- The quote refreshes when the cart changes.",
            "- The quote refreshes when the cart changes.\n- The quote shows a currency.",
        ),
    )
    assert resp.status_code == 201, resp.text


@pytest.mark.parametrize(
    "edit",
    [
        # The PROPOSED/ASSUMED label of an engineering section.
        lambda md: md.replace(contract.ASSUMED_LABEL + "\n\nA shipping quote service", "A shipping "
                              "quote service", 1),
        # Every label at once.
        lambda md: md.replace(contract.ASSUMED_LABEL + "\n\n", ""),
        # The no-map note on the assumptions.
        lambda md: md.replace(contract.NO_MAP_NOTE + "\n\nThe cart service", "The cart service"),
        # The intro's PRD version.
        lambda md: md.replace("(version 1). Product requirements", "(version 7). Product "
                              "requirements"),
        # The intro's PRD.
        lambda md: md.replace("from the approved PRD ", "from the draft PRD ", 1),
    ],
    ids=["one-label", "all-labels", "no-map-note", "intro-version", "intro-prd"],
)  # fmt: skip
async def test_labels_and_the_intro_line_cannot_be_edited(client, runtime, edit):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    resp = await _edit(client, world, created, edit)
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text


async def test_an_edit_is_checked_against_the_prd_versions_text_not_todays(client, runtime):
    world = await make_world(client)
    created = await generated(client, runtime, world)
    # The baseline changes after the spec was written from PRD v1.
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(
            update(Entity)
            .where(Entity.id == world.shipping)
            .values(title="Show shipping cost and free-shipping threshold")
        )
        await s.commit()
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace(
            "Show shipping cost on the cart**", "Show shipping cost and free-shipping threshold**"
        ),
    )
    assert resp.status_code == 422, resp.text
    assert REFUSED in resp.text
    # The text as Oracle wrote it from the PRD version still edits fine.
    resp = await _edit(
        client,
        world,
        created,
        lambda md: md.replace("A shipping quote service", "A cached shipping quote service"),
    )
    assert resp.status_code == 201, resp.text


# --------------------------------------------------------------------------- item 2


async def _link(world, version_id, entity_id, key: str, kind: str = "implements") -> None:
    async with tenant_session(world.ctx.tenant_id) as s:
        s.add(
            DocumentSectionLink(
                document_id=world.prd_id, version_id=version_id, section_key=key, kind=kind,
                entity_id=entity_id,
            )
        )  # fmt: skip
        await s.commit()


async def _approved_v2(client, world) -> uuid.UUID:
    """PRD v2, approved. Its links are not carried forward (the fixture's links have no
    section hash): each test links what v2 adopts."""
    owner = world.ctx.as_("owner")
    v2 = draft("prd_v1.md").replace("wallet payments", "wallet and bank payments")
    assert (await import_md(client, owner, v2)).status_code == 201
    resp = await client.post(f"/v1/documents/{PRD}/versions/2/approve", headers=owner)
    assert resp.status_code == 200, resp.text
    async with tenant_session(world.ctx.tenant_id) as s:
        return await s.scalar(
            select(DocumentVersion.id).where(
                DocumentVersion.document_id == world.prd_id, DocumentVersion.number == 2
            )
        )


async def _spec_on_v1(client, runtime, world) -> str:
    """A spec built from PRD v1 for both requirements, its run finished."""
    owner = world.ctx.as_("owner")
    created = await generated(client, runtime, world)
    run = await get_run(client, owner, created["run_id"])
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{pending(run)['id']}/decide",
        json={"decision": "approved"},
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    return created["spec"]["request"]["id"]


async def _regenerate(client, world, request_id, status=201, **body):
    resp = await client.post(
        f"/v1/spec-requests/{request_id}/regenerate",
        json={"reason": "PRD v2", **body},
        headers=world.ctx.as_("approver"),
    )
    assert resp.status_code == status, resp.text
    return resp.json()


async def test_regenerate_to_a_version_that_did_not_carry_a_requirement_is_refused(client, runtime):
    world = await make_world(client)
    request_id = await _spec_on_v1(client, runtime, world)
    v2 = await _approved_v2(client, world)
    # PRD v2 adopts the saved-cards requirement; the shipping-cost link was not carried.
    await _link(world, v2, world.cards, "s-5-1")
    body = await _regenerate(client, world, request_id, status=422)
    assert body["detail"] == "req-shipping-cost is not in PRD v2"


async def test_regenerate_with_a_requirement_rejected_since_is_refused(client, runtime):
    world = await make_world(client)
    request_id = await _spec_on_v1(client, runtime, world)
    v2 = await _approved_v2(client, world)
    await _link(world, v2, world.cards, "s-5-1")
    await _link(world, v2, world.shipping, "s-5-2")
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(update(Entity).where(Entity.id == world.shipping).values(status="rejected"))
        await s.commit()
    body = await _regenerate(client, world, request_id, status=422)
    assert "req-shipping-cost" in body["detail"]
    assert "req-saved-cards" not in body["detail"]


async def test_a_mentions_link_does_not_adopt_a_requirement(client, runtime):
    world = await make_world(client)
    async with tenant_session(world.ctx.tenant_id) as s:
        r4 = Entity(type="requirement", key="R4", title="R4", status="confirmed", origin="user")
        s.add(r4)
        await s.commit()
    await _link(world, world.prd_v1, r4.id, "s-5-1", kind="mentions")
    body = await request_spec(
        client, world, status=422, requirement_ids=[str(r4.id)], section_keys=["s-5-1"]
    )
    assert body["detail"] == "R4 is not in PRD v1"
    # Any other kind adopts it.
    await _link(world, world.prd_v1, r4.id, "s-5-1", kind="tests")
    await request_spec(client, world, requirement_ids=[str(r4.id)], section_keys=["s-5-1"])


async def test_regenerate_refuses_a_requirement_v2_only_mentions(client, runtime):
    world = await make_world(client)
    request_id = await _spec_on_v1(client, runtime, world)
    v2 = await _approved_v2(client, world)
    await _link(world, v2, world.cards, "s-5-1")
    await _link(world, v2, world.shipping, "s-5-2", kind="mentions")
    body = await _regenerate(client, world, request_id, status=422)
    assert body["detail"] == "req-shipping-cost is not in PRD v2"


async def test_import_drops_and_reports_a_requirement_no_longer_adopted(client, runtime):
    world = await make_world(client)
    owner = world.ctx.as_("owner")
    request_id = await _spec_on_v1(client, runtime, world)
    v2 = await _approved_v2(client, world)
    await _link(world, v2, world.cards, "s-5-1")
    await _link(world, v2, world.shipping, "s-5-2")
    proposal = await _regenerate(client, world, request_id)
    # The link goes before the run imports.
    async with tenant_session(world.ctx.tenant_id) as s:
        await s.execute(
            delete(DocumentSectionLink).where(
                DocumentSectionLink.version_id == v2,
                DocumentSectionLink.entity_id == world.shipping,
            )
        )
        await s.commit()
    runtime.script["spec_draft"] = [
        Outcome(artifacts={"spec.md": spec_md(), "design.json": design_json(world.reqs, SECTIONS)})
    ]
    await start(client, world.ctx.as_("approver"), proposal["run_id"])
    await tick(client, owner)
    run = await get_run(client, owner, proposal["run_id"])
    imported = pending(run)["payload"]["import"]
    assert imported["dropped_requirements"] == ["req-shipping-cost"]
    assert any(p["code"] == "requirement_not_adopted" for p in imported["spec_check"])
    spec = await get_spec(client, owner, request_id)
    assert spec["latest_version"] == 2
    markdown = await stored_markdown(world.ctx.tenant_id, spec["document_slug"], 2)
    front = yaml.safe_load(markdown.split("---")[1])
    assert front["spec"]["requirement_ids"] == [str(world.cards)]
    assert "req-shipping-cost" not in markdown.split("{#requirements}")[1].split("\n## ")[0]


async def test_a_regeneration_whose_spec_import_fails_leaves_the_request_on_its_version(
    client, runtime
):
    world = await make_world(client)
    owner = world.ctx.as_("owner")
    request_id = await _spec_on_v1(client, runtime, world)
    before = (await get_spec(client, owner, request_id))["request"]
    v2 = await _approved_v2(client, world)
    await _link(world, v2, world.cards, "s-5-1")
    await _link(world, v2, world.shipping, "s-5-2")
    proposal = await _regenerate(client, world, request_id)
    runtime.script["spec_draft"] = [
        Outcome(
            artifacts={
                "spec.md": spec_md(skip=("approach",)),
                "design.json": design_json(world.reqs, SECTIONS),
            }
        )
    ]
    await start(client, world.ctx.as_("approver"), proposal["run_id"])
    await tick(client, owner)
    run = await get_run(client, owner, proposal["run_id"])
    assert "error" in pending(run)["payload"]["import"]
    after = await get_spec(client, owner, request_id)
    assert after["latest_version"] == 1
    assert after["request"]["source_version_id"] == before["source_version_id"]
    assert after["request"]["section_keys"] == before["section_keys"]


# --------------------------------------------------------------------------- item 3

LIMIT = 200_000


def _svg(body: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg">{body}</svg>'


def _fill(unit: str, around: tuple[str, str] = ("", ""), size: int = LIMIT) -> str:
    """``unit`` repeated to a file of about ``size`` bytes inside ``around``."""
    room = size - len(around[0]) - len(around[1]) - 64
    return around[0] + unit * (room // len(unit)) + around[1]


# Each payload is (kind, content): the reviewer's two, then the worst cases we found at
# the 200 KB limit, one for each check that used to backtrack.
SLOW_PAYLOADS = {
    "reviewer-lt-runs-40k": ("static", "<<" * 20_000 + ">"),
    "reviewer-svg-text-160k": ("svg", _svg("<text>" + "&lt;" * 40_000 + "</text>")),
    "lt-runs": ("html", _fill("<<", ("", ">"))),
    "lt-runs-static": ("static", _fill("<<", ("", ">"))),
    "escaped-lt-svg": ("svg", _fill("&lt;", (_svg("<text>")[:-6], "</text></svg>"))),
    "escaped-lt-html": ("html", _fill("&lt;", ("<p>", "</p>"))),
    "unclosed-style-tags": ("html", _fill("&lt;style ", ("<p>", "</p>"))),
    "src-then-spaces": ("html", _fill(" ", ("<p>&lt;x src=", "&gt;</p>"))),
    "url-then-spaces": ("svg", _fill(" ", (_svg("<style>a{b:url(")[:-6], "#a)}</style></svg>"))),
    "unclosed-urls-css": ("svg", _fill("url(", (_svg("<style>")[:-6], "</style></svg>"))),
    "unclosed-comments-css": ("svg", _fill("/* ", (_svg("<style>")[:-6], "</style></svg>"))),
    "long-attribute-name": ("static", _fill("a", ("<p ", ">"))),
    "quoted-name-run": ("html", _fill("a", ('<p title="&quot;', '">x</p>'))),
    "event-handler-runs": ("html", _fill('&lt;p "on', ("<p>", "</p>"))),
    "unclosed-quotes": ("html", _fill('&lt;"', ("<p>", "</p>"))),
}


@pytest.mark.parametrize("name", list(SLOW_PAYLOADS))
def test_the_static_check_is_linear(name):
    from oracle.specs.sanitize import sanitize_svg, sanitize_wireframe, static_problems

    kind, content = SLOW_PAYLOADS[name]
    assert len(content.encode()) <= LIMIT
    started = time.perf_counter()
    if kind == "static":
        static_problems(content, "html")
        static_problems(content, "svg")
    elif kind == "svg":
        sanitize_svg(content, title="x")
    else:
        sanitize_wireframe(content, title="x")
    elapsed = time.perf_counter() - started
    assert elapsed < 1.0, f"{name}: {elapsed:.1f}s"


def test_a_worst_case_design_bundle_is_checked_in_under_a_second():
    from oracle.specs.design import check_design

    reqs, sections = [str(uuid.uuid4())], ["s-1"]
    bundle = json.loads(design_json(reqs, sections, screens=2))
    bundle["flows"][0]["svg"] = SLOW_PAYLOADS["escaped-lt-svg"][1]
    bundle["wireframes"][0]["html"] = SLOW_PAYLOADS["lt-runs"][1]
    bundle["wireframes"][1]["html"] = SLOW_PAYLOADS["escaped-lt-html"][1]
    started = time.perf_counter()
    check_design(json.dumps(bundle), prd_sections=set(sections), requirement_ids=set(reqs))
    assert time.perf_counter() - started < 1.0


def test_quoted_local_css_references_are_local():
    from oracle.specs.sanitize import sanitize_svg, static_problems

    for ref in ("url(#arrow)", "url('#arrow')", 'url("#arrow")', "url( '#arrow' )"):
        svg = _svg(
            '<defs><marker id="arrow"><path d="M0,0 L1,1"/></marker></defs>'
            f'<line x1="0" y1="0" x2="1" y2="1" marker-end="{ref.replace(chr(34), "&quot;")}"/>'
        )
        out = sanitize_svg(svg, title="x")
        assert out.safe, (ref, out.blocked)
        assert not static_problems(out.content, "svg"), ref
    for ref in ("url('http://x/a')", 'url("//x/a")', "url( x )"):
        out = sanitize_svg(_svg(f'<rect fill="{ref.replace(chr(34), "&quot;")}"/>'), title="x")
        assert not out.safe, ref


async def test_the_design_check_runs_off_the_event_loop_with_a_time_cap(
    client, runtime, monkeypatch
):
    from oracle.specs import service

    def stalls(*args, **kwargs):
        time.sleep(5)
        raise AssertionError("not reached in time")

    monkeypatch.setattr(service, "check_design", stalls)
    monkeypatch.setattr(service, "DESIGN_CHECK_SECONDS", 0.2, raising=False)
    world = await make_world(client)
    owner = world.ctx.as_("owner")
    started = time.perf_counter()
    created = await generated(client, runtime, world)
    assert time.perf_counter() - started < 4
    run = await get_run(client, owner, created["run_id"])
    imported = pending(run)["payload"]["import"]
    assert imported["version"] == 1
    assert [p["code"] for p in imported["design"]["problems"]] == ["design_check_timeout"]
    spec = await get_spec(client, owner, created["spec"]["request"]["id"])
    assert spec["request"]["status"] == "partial"
