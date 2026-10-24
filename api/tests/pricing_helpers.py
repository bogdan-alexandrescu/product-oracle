"""Shared setup for the H9 Pricing input tests: a synthetic pricing memo, starting one,
a pricing_memo run driven by the FakeRuntime, and a second owner. Made-up names only."""

from typing import Any

from oracle.auth.models import User
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx
from tests.update_helpers import import_md

QUESTION = "Should the team plan move from per-seat to a flat price per team?"
OPTIONS = (
    ("keep", "Keep per-seat pricing", "reversible", False),
    ("flat-team", "Flat price per team", "irreversible", True),
)
FLAT = (
    "Teams of 10 to 50 pay $400 a month, flat. Smaller teams keep per-seat pricing.\n\n"
    "Affects the Team plan and its existing customers."
)
KEEP = "Nothing changes: $20 per seat a month."


def memo_md(
    slug: str,
    *,
    question: str | None = QUESTION,
    options: tuple[tuple[str, str, str, bool], ...] = OPTIONS,
    sections: tuple[str, ...] | None = None,
    bodies: dict[str, str] | None = None,
    research_plan: str = "- Five pricing interviews with teams of 10+.",
    data_points: str = "- $20 per seat a month, list price, as of 2026-10-01 (c1)\n"
    "- $400 a month, the flat price tested, as of 2026-10-01 (c1)\n"
    "- 10 and 50 seats, the segment bounds (c1)",
) -> str:
    """A pricing memo: question, recommendation and options brief first, then detail."""
    bodies = {"keep": KEEP, "flat-team": FLAT, **(bodies or {})}
    fm = [
        "---",
        f"document: {slug}",
        'title: "Team plan pricing"',
        "kind: pricing",
        "template: pricing-options-memo",
        "brief: [question, recommendation, options]",
    ]
    if question is not None:
        fm.append(f'question: "{question}"')
    fm.append("options:")
    for oid, title, reversibility, recommended in options:
        fm.append(
            f'  - {{id: {oid}, title: "{title}", reversibility: {reversibility}, '
            f"recommended: {'true' if recommended else 'false'}}}"
        )
    fm += ["evidence_window: {from: 2026-04-01, to: 2026-10-23}", "---"]
    titles = {oid: title for oid, title, _, _ in options}
    option_parts: list[str] = []
    for oid in sections if sections is not None else tuple(titles):
        option_parts += [
            f"### {titles.get(oid, oid)} {{#option-{oid}}}",
            "",
            bodies.get(oid, "What changes."),
            "",
        ]
    body = [
        "",
        "# Team plan pricing {#title}",
        "",
        "## The question {#question}",
        "",
        f"{question or 'No question'} Teams ask for one price; the pricing owner decides.",
        "",
        "## Recommendation {#recommendation}",
        "",
        "Test a flat team price with new teams first.",
        "",
        "## Options {#options}",
        "",
        *option_parts,
        "# Full version {#full}",
        "",
        "## Willingness to pay {#willingness-to-pay}",
        "",
        "Pricing interviews put too expensive above the flat price.",
        "",
        "## Win and loss {#win-loss}",
        "",
        "Lost on price: a third of losses.",
        "",
        "## Research plan {#research-plan}",
        "",
        research_plan,
        "",
        "## Sources and data points {#sources}",
        "",
        "### Data points {#sources-data}",
        "",
        data_points,
        "",
    ]
    return "\n".join(fm + body)


async def start_memo(client, ctx: Ctx, who: str = "approver", **extra: Any):
    return await client.post(
        "/v1/drafts",
        json={
            "kind": "pricing",
            "title": "Team plan pricing",
            "template": "pricing-options-memo",
            "question": QUESTION,
            **extra,
        },
        headers=ctx.as_(who),
    )


async def started_memo(client, ctx: Ctx, **extra: Any) -> str:
    resp = await start_memo(client, ctx, **extra)
    assert resp.status_code == 201, resp.text
    return resp.json()["slug"]


async def approved_memo(client, ctx: Ctx, markdown: str | None = None) -> str:
    """A memo whose version 2 (a person's import) an owner approved."""
    slug = await started_memo(client, ctx)
    resp = await import_md(client, ctx.as_("approver"), slug, markdown or memo_md(slug))
    assert resp.status_code == 201, resp.text
    resp = await client.post(f"/v1/documents/{slug}/versions/2/approve", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text
    return slug


async def add_owner(ctx: Ctx, name: str = "second") -> User:
    """Another owner, created after ``ctx``'s (so never the default pricing owner)."""
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email=f"{name}@example.com", password_hash="x", role="owner")
        s.add(user)
        await s.commit()
    ctx.users[name] = user
    return user


async def set_level(client, ctx: Ctx, level: str) -> None:
    resp = await client.put(
        "/v1/autonomy/pricing_input",
        json={"level": level, "reason": "Testing the pricing input levels"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text


async def drafted_by_run(client, ctx: Ctx, runtime, slug: str, markdown: str, who="approver"):
    """A pricing_memo run on ``slug`` whose agents hand back ``markdown``: created and
    started by ``who``, ticked to its pricing_review checkpoint. Returns the run."""
    headers = ctx.as_(who)
    runtime.script["pricing_memo"] = [Outcome(artifacts={"pricing.md": markdown})]
    resp = await client.post(
        "/v1/runs", json={"flow": "pricing_memo", "document": slug}, headers=headers
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    est = await client.post(f"/v1/runs/{run['id']}/estimate", headers=headers)
    assert est.status_code == 200, est.text
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=headers)
    assert resp.status_code == 200, resp.text
    resp = await client.post("/v1/internal/tick", headers=ctx.as_("token"))
    assert resp.status_code == 200 and resp.json()["errors"] == [], resp.text
    resp = await client.get(f"/v1/runs/{run['id']}", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()
