"""#203 (A5) AC10: the invite message, and the invite email's template B (owner decisions,
2026-10-23). An owner may add a personal message (plain text, at most 500 characters) to
an invite; it is stored on the invite, sent in the email and sent again by Resend. Every
invite email is template B: a designed HTML part with the Oracle mark inline, beside a
plain-text part saying the same; replies reach the inviter.

Against a fake mailer: no Google or mail calls. Made-up companies and people.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import base64
import email
import html
import re
import uuid
from datetime import UTC, datetime
from email import policy as email_policy
from pathlib import Path

import pytest
from sqlalchemy import select

from oracle.members import delivery, mailer
from oracle.members.models import Invite
from oracle.tenancy import tenant_session
from tests.test_invite_delivery import PUBLIC, FakeMinter, iap, mail, owner  # noqa: F401
from tests.test_members import token_with_role

WEB_MARK = Path(__file__).resolve().parents[2] / "web" / "app" / "apple-icon.png"
LINK = "https://oracle.example.test/"
NOTE = "Excited to have you review the Q4 roadmap with us."


def _email(**kw) -> mailer.InviteEmail:
    args = {
        "to": "jordan.lee@example.com",
        "company": "Acme Robotics",
        "role": "approver",
        "inviter": "Dana Reyes",
        "reply_to": "dana.reyes@example.com",
        "link": LINK,
        "message": NOTE,
        "expires_at": datetime(2026, 11, 6, 17, 0, tzinfo=UTC),
        "zone": "America/Los_Angeles",
    }
    args.update(kw)
    return mailer.invite_email(**args)


def _parsed(message: mailer.InviteEmail) -> email.message.EmailMessage:
    raw = mailer.GmailApiMailer("oracle@example.com", FakeMinter())._raw(message)
    return email.message_from_bytes(base64.urlsafe_b64decode(raw), policy=email_policy.default)


def _visible(page: str) -> str:
    """The HTML part's words as a reader sees them: no tags, comments, styles or entities."""
    page = re.sub(r"<!--.*?-->", " ", page, flags=re.S)
    page = re.sub(r"<(style|title)[^>]*>.*?</\1>", " ", page, flags=re.S)
    page = re.sub(r'<div style="display:none[^>]*>.*?</div>', " ", page, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", " ", page))
    return re.sub(r"\s+", " ", text.replace(" ", " ")).strip()


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


# --- The template ----------------------------------------------------------------------------


def test_the_subject_names_the_company_and_the_role_without_a_possessive():
    """protects=the subject; fails_when=it keeps the old "<company> Product Oracle" wording or
    a description; no_claim=the rendered header (the gmail tests)."""
    message = _email(company="Acme Robotics")
    assert message.subject == "You're invited to join Acme Robotics on Product Oracle as Approver"
    for role, name in mailer.ROLE_NAMES.items():
        assert _email(role=role).subject.endswith(f" as {name}")


def test_the_email_says_who_where_what_and_the_note():
    """protects=the HTML and text parts carry the inviter, company, role pill, link, address,
    expiry and note; fails_when=a part misses one, or a role description appears;
    no_claim=how a mail client draws it."""
    message = _email()
    seen = _visible(message.html)
    for part in (seen, _flat(message.text)):
        assert "Dana Reyes invited you to join Acme Robotics on Product Oracle" in part
        assert LINK in part
        assert "Sign in with Google using jordan.lee@example.com" in part
        assert "Expires Fri Nov 6, 9:00 AM PST" in part
        assert NOTE in part
        assert "an owner of Product Oracle at Acme Robotics" in part
        assert "Questions? Reply to this email and it reaches Dana." in part
        assert "Acme Robotics's" not in part
    assert "A note from Dana" in seen
    assert "Message from Dana:" in message.text
    # The pill is the role name alone.
    assert re.search(r'class="chip"[^>]*>Approver</td>', message.html)
    assert "decide" not in seen.lower()
    assert f'href="{LINK}"' in message.html


def test_with_no_message_the_note_block_is_left_out():
    """protects=no empty note block; fails_when=the "A note from" block or its marker shows
    with no message; no_claim=the stored value (API tests below)."""
    for empty in (None, ""):
        message = _email(message=empty)
        assert "A note from" not in message.html
        assert 'class="quote"' not in message.html
        assert "Message from" not in message.text
        assert "“" not in _visible(message.html)


def test_with_no_expiry_the_expiry_line_is_left_out():
    """protects=no expiry line without an expiry; fails_when=an "Expires" line (or a blank one)
    shows; no_claim=invites that carry an expiry (A5 part 1)."""
    message = _email(expires_at=None)
    assert "Expires" not in message.html
    assert "Expires" not in message.text
    assert "Sign in with Google using" in message.html


def test_the_message_is_escaped_and_keeps_its_line_breaks():
    """protects=the message is text, never HTML; fails_when=a tag, attribute or entity from
    the owner reaches the HTML part, or a line break is lost; no_claim=the web's rendering."""
    note = 'Hi <b>Jordan</b> & team,\n<img src="https://evil.example/x.png">\r\nSee you "soon"'
    message = _email(message=note)
    assert "<b>Jordan</b>" not in message.html
    assert '<img src="https' not in message.html
    assert "Hi &lt;b&gt;Jordan&lt;/b&gt; &amp; team,<br>" in message.html
    assert "&lt;img src=&quot;https://evil.example/x.png&quot;&gt;<br>See you &quot;soon&quot;" in (
        message.html
    )
    # The text part keeps the message's lines as typed.
    assert (
        'Hi <b>Jordan</b> & team,\n<img src="https://evil.example/x.png">\nSee you' in message.text
    )


def test_company_inviter_and_address_are_escaped_too():
    """protects=no field the API takes from people becomes markup; fails_when=a company name
    with markup reaches the HTML unescaped; no_claim=header encoding."""
    message = _email(company="Acme <i>Robotics</i> & Co", inviter='Dana "D" <Reyes>')
    assert "<i>Robotics</i>" not in message.html
    assert "Acme&nbsp;&lt;i&gt;Robotics&lt;/i&gt;" in message.html or (
        "Acme &lt;i&gt;Robotics&lt;/i&gt;" in message.html
    )
    assert "Dana &quot;D&quot; &lt;Reyes&gt;" in message.html


@pytest.mark.parametrize(
    ("moment", "words"),
    [
        # Before and after the US change back to standard time (Nov 1, 2026).
        (datetime(2026, 10, 30, 16, 0, tzinfo=UTC), "Fri Oct 30, 9:00 AM PDT"),
        (datetime(2026, 11, 6, 17, 0, tzinfo=UTC), "Fri Nov 6, 9:00 AM PST"),
    ],
)
def test_the_expiry_is_in_the_company_time_zone_with_its_abbreviation(moment, words):
    """protects=the expiry reads in the Company time zone, with the abbreviation in force on
    that day; fails_when=it shows UTC, ISO, or the wrong side of a DST change;
    no_claim=reading the zone from the settings (delivery test below)."""
    message = _email(expires_at=moment)
    assert f"Expires {words}" in _visible(message.html)
    assert f"Expires {words}" in message.text
    for part in (message.html, message.text):
        assert "UTC" not in part and "2026-1" not in part


def test_another_company_zone_names_its_own_abbreviation():
    message = _email(expires_at=datetime(2026, 11, 6, 17, 0, tzinfo=UTC), zone="Asia/Tokyo")
    assert "Expires Sat Nov 7, 2:00 AM JST" in message.text


def test_the_note_label_uses_the_first_name_or_the_address():
    """protects=the note label and footer name; fails_when=the full name, or a broken word of
    an address, is used; no_claim=where the name comes from (delivery)."""
    assert "A note from Dana" in _email(inviter="Dana Reyes").html
    plain = _email(inviter="dana@example.com", reply_to="dana@example.com")
    assert "A note from dana@example.com" in plain.html
    assert "it reaches dana@example.com." in plain.text


def test_with_no_inviter_address_there_is_no_reply_sentence():
    """protects=the footer never promises a reply that reaches no one; fails_when=the "Questions?"
    sentence stays with no Reply-To; no_claim=the header (gmail test below)."""
    message = _email(reply_to=None, inviter="An owner")
    assert message.reply_to is None
    for part in (message.html, message.text):
        assert "Questions?" not in part
        assert "reaches" not in part
        assert "Not expecting it? Ignore this email" in part


def test_the_plain_text_part_matches_the_html():
    """protects=the text/plain part says what the HTML says, line for line in meaning;
    fails_when=a fact is in one part only; no_claim=layout."""
    for kw in ({}, {"message": None}, {"expires_at": None}, {"reply_to": None}):
        message = _email(**kw)
        seen, text = _visible(message.html), _flat(message.text)
        facts = [
            "invited you to join Acme Robotics on Product Oracle",
            "Approver",
            LINK,
            "Sign in with Google using jordan.lee@example.com",
            "Expires",
            NOTE,
            "Questions? Reply to this email and it reaches Dana.",
            "Not expecting it? Ignore this email",
        ]
        for fact in facts:
            assert (fact in seen) == (fact in text), (kw, fact)


# --- The MIME message ---------------------------------------------------------------------------


def test_the_mark_is_an_inline_cid_part_never_a_remote_image():
    """protects=the Oracle mark is attached inline (multipart/related, Content-ID) and the HTML
    points at it by cid; fails_when=the image is a URL or missing; no_claim=client rendering."""
    parsed = _parsed(_email())
    assert parsed.get_content_type() == "multipart/alternative"
    plain, related = list(parsed.iter_parts())
    assert plain.get_content_type() == "text/plain"
    assert related.get_content_type() == "multipart/related"
    page, image = list(related.iter_parts())
    assert page.get_content_type() == "text/html"
    assert image.get_content_type() == "image/png"
    cid = image["Content-ID"].strip("<>")
    assert image.get_content_disposition() == "inline"
    assert image.get_content() == WEB_MARK.read_bytes()
    body = page.get_content()
    assert f'src="cid:{cid}"' in body
    assert not re.search(r'<img[^>]+src="(?!cid:)', body)
    assert "oracle-mark.png" not in body


def test_reply_to_is_the_inviter_and_from_stays_the_mailbox():
    """protects=replies reach the inviter; fails_when=Reply-To is missing or From changes;
    no_claim=Gmail keeping the header (it does for delegated sends)."""
    parsed = _parsed(_email())
    assert parsed["From"] == "oracle@example.com"
    assert parsed["Reply-To"] == "dana.reyes@example.com"
    assert parsed["Subject"] == "You're invited to join Acme Robotics on Product Oracle as Approver"


def test_no_inviter_address_sets_no_reply_to():
    parsed = _parsed(_email(reply_to=None, inviter="An owner"))
    assert parsed["Reply-To"] is None


@pytest.mark.parametrize(
    "address", ["a@evil.com,b@corp.com", "Pat <b@corp.com>", "x\r\nBcc: b@c.com"]
)
def test_a_reply_to_that_is_not_one_plain_address_is_dropped(address):
    """protects=the Reply-To header is only ever one plain address; fails_when=a crafted
    inviter address adds recipients or headers; no_claim=the To header (its own tests)."""
    message = _email(reply_to=address)
    assert message.reply_to is None
    assert "Questions?" not in message.text
    raw = base64.urlsafe_b64decode(
        mailer.GmailApiMailer("oracle@example.com", FakeMinter())._raw(message)
    )
    assert b"Bcc" not in raw.split(b"\n\n", 1)[0]
    assert b"Reply-To" not in raw.split(b"\n\n", 1)[0]


# --- Through the API -----------------------------------------------------------------------------


async def test_the_invite_stores_returns_and_sends_the_message(client, owner, iap, mail):  # noqa: F811
    """protects=POST /v1/invites keeps the message, GET returns it, and the email carries it
    with Reply-To the owner; fails_when=it is dropped anywhere; no_claim=the web form (e2e)."""
    _, headers = owner
    resp = await client.post(
        "/v1/invites",
        json={
            "email": "pat@example.com",
            "role": "approver",
            "message": "  Welcome aboard!\nPat  ",
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["message"] == "Welcome aboard!\nPat"
    listed = (await client.get("/v1/invites", headers=headers)).json()
    assert [i["message"] for i in listed] == ["Welcome aboard!\nPat"]
    await delivery.drain()
    [sent] = mail.sent
    assert "Welcome aboard!<br>Pat" in sent.html
    assert "A note from Admin" in sent.html
    assert sent.reply_to == "admin@example.com"
    assert sent.subject == "You're invited to join Example Co on Product Oracle as Approver"
    assert "it reaches Admin." in sent.text


async def test_no_message_is_null_and_leaves_the_block_out(client, owner, iap, mail):  # noqa: F811
    _, headers = owner
    for body in ({}, {"message": None}, {"message": "   "}):
        address = f"p{uuid.uuid4().hex[:6]}@example.com"
        resp = await client.post(
            "/v1/invites", json={"email": address, "role": "viewer", **body}, headers=headers
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["message"] is None
    await delivery.drain()
    assert len(mail.sent) == 3
    assert all("A note from" not in m.html for m in mail.sent)


async def test_a_message_over_500_characters_is_refused(client, owner, iap, mail):  # noqa: F811
    """protects=the 500-character limit; fails_when=a longer message is stored or sent;
    no_claim=the web counter (e2e)."""
    tenant_id, headers = owner
    resp = await client.post(
        "/v1/invites",
        json={"email": "pat@example.com", "role": "viewer", "message": "x" * 501},
        headers=headers,
    )
    assert resp.status_code == 422, resp.text
    await delivery.drain()
    async with tenant_session(tenant_id) as s:
        assert (await s.scalars(select(Invite))).all() == []
    assert mail.attempts == 0
    ok = await client.post(
        "/v1/invites",
        json={"email": "pat@example.com", "role": "viewer", "message": "x" * 500},
        headers=headers,
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["message"] == "x" * 500


async def test_a_non_owner_is_refused_as_before(client, owner, iap, mail):  # noqa: F811
    """protects=owners only; fails_when=an approver's invite with a message is accepted;
    no_claim=A5 part 1's approver invites."""
    tenant_id, _ = owner
    for role in ("approver", "commenter", "viewer"):
        headers = await token_with_role(tenant_id, role)
        resp = await client.post(
            "/v1/invites",
            json={"email": "pat@example.com", "role": "viewer", "message": "Hello"},
            headers=headers,
        )
        assert resp.status_code == 403, (role, resp.text)
    await delivery.drain()
    assert mail.attempts == 0


async def test_resend_sends_the_same_message(client, owner, iap, mail, monkeypatch):  # noqa: F811
    """protects=Resend sends the stored message again; fails_when=the resent email loses it;
    no_claim=the cooldown (its own test)."""
    _, headers = owner
    monkeypatch.setattr(delivery, "RESEND_COOLDOWN", delivery.RESEND_COOLDOWN * 0)
    resp = await client.post(
        "/v1/invites",
        json={"email": "pat@example.com", "role": "commenter", "message": "See you <Monday>"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    await delivery.drain()
    again = await client.post(f"/v1/invites/{resp.json()['id']}/email", headers=headers)
    assert again.status_code == 200, again.text
    assert again.json()["message"] == "See you <Monday>"
    await delivery.drain()
    first, second = mail.sent
    assert first.html == second.html and first.text == second.text
    assert "See you &lt;Monday&gt;" in second.html
    assert second.reply_to == "admin@example.com"


async def test_an_inviter_with_no_address_gets_no_reply_to(client, owner, iap, mail):  # noqa: F811
    """protects=an invite made by a service token (no person) sets no Reply-To and drops the
    reply sentence; fails_when=a made-up or empty address is used; no_claim=run tokens, which
    cannot invite at all."""
    tenant_id, _ = owner
    headers = await token_with_role(tenant_id, "owner")
    resp = await client.post(
        "/v1/invites",
        json={"email": "pat@example.com", "role": "viewer", "message": "Hello"},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    await delivery.drain()
    [sent] = mail.sent
    assert sent.reply_to is None
    assert "Questions?" not in sent.text and "Questions?" not in sent.html
    assert "A note from" in sent.html


def test_the_mark_beside_the_mailer_is_the_apps_icon():
    """protects=the inline mark is web/app/apple-icon.png byte for byte; fails_when=the copy
    beside the mailer drifts; no_claim=-."""
    assert mailer.MARK_PNG.read_bytes() == WEB_MARK.read_bytes()
