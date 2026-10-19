"""§16 item 8: third-party limits are classified as rate/capacity, API eligibility,
permissions or policy, and recommended options stay compliant. Options that evade
platform restrictions, abuse identities or accounts, or message people without
permission are flagged, never recommended, and can never be selected (§6)."""

import pytest

from oracle.blockers import policy
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import add_option, approve_compliance, create_blocker

EVASION = [
    "Rotate proxies to bypass the rate limit",
    "Spoof the user agent so the provider cannot detect our crawler",
    "Circumvent the quota by spreading calls over residential proxies",
    "Scrape the pages despite the terms of service",
    "Use a CAPTCHA solving service to get past the challenge",
]
IDENTITY = [
    "Create extra accounts per company to multiply the quota",
    "Register multiple accounts to get around the per-account limit",
    "Buy aged accounts that are already eligible for the API",
    "Impersonate the customer when calling the API",
    "Share one partner login across every company",
]
MESSAGING = [
    "Send unsolicited direct messages to the partner's users",
    "Mass DM everyone who follows the brand",
    "Message people without their consent to invite them",
    "Auto-follow and auto-DM new users of the network",
    "Blast emails to scraped contacts",
]
COMPLIANT = [
    "Batch and cache lookups within the published quota",
    "Queue requests and back off within the permitted rate instead of bypassing the limit",
    "Apply for the provider's approved partner program",
    "Ask users to opt in before we message them",
    "Users connect their own account through the provider's OAuth consent",
    "Negotiate a higher tier with the provider",
    "Never create extra accounts; request a quota increase instead",
]


@pytest.mark.parametrize(
    ("text", "category"),
    [(t, "evasion") for t in EVASION]
    + [(t, "identity_abuse") for t in IDENTITY]
    + [(t, "unauthorized_messaging") for t in MESSAGING],
)
def test_the_screen_flags_prohibited_tactics(text, category):
    flags = policy.screen(text)
    assert flags, text
    assert category in {f.category for f in flags}, (text, flags)


@pytest.mark.parametrize("text", COMPLIANT)
def test_the_screen_leaves_compliant_options_alone(text):
    assert policy.screen(text) == []


def test_every_suggested_compliant_path_passes_the_screen():
    for kind in policy.LIMIT_KINDS:
        for path in policy.compliant_paths(kind):
            assert policy.screen(f"{path.label}. {path.guidance}") == [], (kind, path)


def test_limit_kinds_are_separated_with_their_own_paths():
    """Throughput is solved differently from permission, eligibility and policy (§6)."""
    approaches = {k: {p.approach for p in policy.compliant_paths(k)} for k in policy.LIMIT_KINDS}
    assert approaches["capacity"] >= {"architecture", "operations"}
    # Efficiency cannot grant a permission, an eligibility or a policy exception.
    for kind in ("eligibility", "permission", "policy"):
        assert "architecture" not in approaches[kind], kind
    assert "partnership" in approaches["eligibility"]
    assert "alternative_workflow" in approaches["permission"]
    assert "alternative_workflow" in approaches["policy"]
    labels = {policy.LIMIT_KIND_LABELS[k] for k in ("capacity", "eligibility", "permission",
                                                      "policy")}  # fmt: skip
    assert labels == {"Rate or capacity limit", "API eligibility", "Permissions",
                      "Third-party policy"}  # fmt: skip


async def test_four_third_party_limits_are_classified_separately(client):
    ctx = await make_ctx()
    kinds = {
        "capacity": "Posting is capped at 50 an hour per account",
        "eligibility": "Direct-message API access needs an approved partner program",
        "permission": "Reading a member's history needs a scope the member grants",
        "policy": "The network forbids automated first messages",
    }
    for kind, statement in kinds.items():
        await create_blocker(client, ctx, key=f"network-{kind}", statement=statement,
                             limit_kind=kind, third_party="Example social network")  # fmt: skip
    for kind in kinds:
        listed = (await client.get(f"/v1/blockers?limit_kind={kind}",
                                   headers=ctx.as_("viewer"))).json()  # fmt: skip
        assert [b["key"] for b in listed] == [f"network-{kind}"]
        strategy = (await client.get(f"/v1/blockers/{listed[0]['id']}",
                                     headers=ctx.as_("viewer"))).json()  # fmt: skip
        assert strategy["blocker"]["limit_kind"] == kind
        assert strategy["blocker"]["third_party"] == "Example social network"
        assert {p["approach"] for p in strategy["compliant_paths"]} == {
            p.approach for p in policy.compliant_paths(kind)
        }
        assert strategy["prohibited"] == policy.PROHIBITED


@pytest.mark.parametrize(
    ("title", "category"),
    [(EVASION[0], "evasion"), (IDENTITY[0], "identity_abuse"),
     (MESSAGING[0], "unauthorized_messaging")],
)  # fmt: skip
async def test_a_prohibited_option_is_flagged_and_can_never_be_chosen(client, title, category):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    resp = await add_option(client, ctx, b["id"], title=title, technical_feasibility="high",
                            policy_feasibility="high")  # fmt: skip
    assert resp.status_code == 201, resp.text
    opt = resp.json()
    assert opt["compliance"] == "non_compliant"
    assert opt["status"] == "rejected"
    assert opt["policy_feasibility"] == "low"
    assert category in {f["category"] for f in opt["policy_flags"]}
    h = ctx.as_("approver")
    v = opt["lock_version"]
    resp = await client.patch(
        f"/v1/blocker-options/{opt['id']}", json={"lock_version": v, "compliance": "compliant"},
        headers=h,
    )  # fmt: skip
    assert resp.status_code == 422
    for action, body in (("select", {"reason": "fast"}), ("fallback", {})):
        resp = await client.post(
            f"/v1/blocker-options/{opt['id']}/{action}", json={"lock_version": v, **body},
            headers=h,
        )  # fmt: skip
        assert resp.status_code == 422, action
    strategy = (await client.get(f"/v1/blockers/{b['id']}", headers=h)).json()
    assert strategy["recommended_option_id"] is None


async def test_hiding_a_tactic_in_the_details_is_flagged_too(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    resp = await add_option(client, ctx, b["id"], details={"fallback": IDENTITY[1]})
    assert resp.json()["compliance"] == "non_compliant"


async def test_a_selected_option_cannot_be_edited_into_a_prohibited_one(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    opt = await approve_compliance(client, ctx, (await add_option(client, ctx, b["id"])).json())
    resp = await client.post(
        f"/v1/blocker-options/{opt['id']}/select",
        json={"lock_version": opt["lock_version"], "reason": "Within quota"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    chosen = next(o for o in resp.json()["options"] if o["id"] == opt["id"])
    resp = await client.patch(
        f"/v1/blocker-options/{opt['id']}",
        json={"lock_version": chosen["lock_version"], "details": {"fallback": EVASION[0]}},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 422
    resp = await client.patch(
        f"/v1/blocker-options/{opt['id']}",
        json={"lock_version": chosen["lock_version"], "title": "Something else"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 409  # a selection is a decision on this exact option


async def test_the_recommendation_is_always_a_compliant_option(client):
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx))["blocker"]
    # The evasive option claims the best feasibility; it must still lose.
    await add_option(client, ctx, b["id"], title=EVASION[0], technical_feasibility="high",
                     policy_feasibility="high")  # fmt: skip
    unreviewed = (await add_option(client, ctx, b["id"], title="Unreviewed idea",
                                   technical_feasibility="high")).json()  # fmt: skip
    medium = await approve_compliance(client, ctx, (await add_option(
        client, ctx, b["id"], title="Queue within the permitted rate", approach="operations",
        technical_feasibility="medium", policy_feasibility="high",
    )).json())  # fmt: skip
    strategy = (await client.get(f"/v1/blockers/{b['id']}", headers=ctx.as_("viewer"))).json()
    assert strategy["recommended_option_id"] == medium["id"]
    assert strategy["recommended_option_id"] != unreviewed["id"]
