"""ask-fresh (the owner's pick C, 2026-10-28, "Always a clean slate"): every time Ask opens
in Simple it is a new, empty chat about its page; Recent chats lists the person's last
chats from any page, each named by its page; choosing one continues it; meeting chats
never appear there. Against Postgres, with S8's real meetings module.

People: owner, decider, approver, commenter, viewer (tests.test_simple_meetings_api.world).

Test cards (protects / fails_when / no_claim):

- test_new_chat_per_role: protects=for each role a line sent with ``new_chat`` starts a
  new chat (a new id) about its page, holding only that line and Oracle's reply, and the
  next line sent with its ``chat_id`` continues it; fails_when=a new chat shows an older
  chat's lines, or a continued line starts another chat; no_claim=the panel (web spec).
- test_recent_lists_own_chats_by_page_not_meetings: protects=``GET /v1/simple/chats``
  lists the caller's own Ask chats from any page, newest first, each with its page's
  name; another person's chats and meeting chats never appear; fails_when=a meeting chat
  or someone else's chat is listed, or a page is named by its route; no_claim=the time's
  words (the web formats them in the company's time zone).
- test_chat_is_the_callers_own: protects=reading, continuing or linking another person's
  chat (or a meeting's) is 404; fails_when=a chat id lets anyone read it.
- test_link_ask_discussion: protects=the chat's handed-off Ask discussion (the caller's
  own private panel chat) is linked to it and comes back on Recent and the thread;
  another person's discussion is 404; fails_when=a chat reopened from Recent loses its
  Ask answers.
"""

from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import MEETINGS, start, world

ASK = "/v1/simple/chat/messages"
ROLES = ("owner", "decider", "approver", "commenter", "viewer")


async def post(client, w, who: str, text: str, **body) -> dict:
    r = await client.post(ASK, json={"text": text, **body}, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def recent(client, w, who: str) -> list[dict]:
    r = await client.get("/v1/simple/chats", headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["items"]


async def test_new_chat_per_role(client):
    w = await world()
    for who in ROLES:
        a = await post(client, w, who, "who owns Ledger v2?", page="/simple", new_chat=True)
        assert a["id"] and len(a["messages"]) == 2, who
        b = await post(client, w, who, "when is Ledger v2?", page="/simple", new_chat=True)
        assert b["id"] != a["id"], who
        assert [m["body"] for m in b["messages"]][0] == "when is Ledger v2?"
        assert len(b["messages"]) == 2
        c = await post(client, w, who, "who decides Ledger v2?", page="/simple",
                       chat_id=a["id"])  # fmt: skip
        assert c["id"] == a["id"] and len(c["messages"]) == 4, who
        r = await client.get("/v1/simple/chat", params={"chat": a["id"]},
                             headers=w.ctx.as_(who))  # fmt: skip
        assert r.status_code == 200 and len(r.json()["messages"]) == 4


async def test_recent_lists_own_chats_by_page_not_meetings(client):
    w = await world()
    m = await start(client, w)
    r = await client.post(f"{MEETINGS}/{m['id']}/chat/messages", json={"text": "who owns Ledger v2?"},
                          headers=w.ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    home = await post(client, w, "commenter", "who owns Ledger v2?", page="/simple", new_chat=True)
    road = await post(client, w, "commenter", "when is Ledger v2?", page="/simple/roadmap",
                      new_chat=True)  # fmt: skip
    await post(client, w, "approver", "who owns Ledger v2?", page="/simple", new_chat=True)
    items = await recent(client, w, "commenter")
    assert [x["id"] for x in items] == [road["id"], home["id"]]
    assert [x["page_name"] for x in items] == ["Roadmap", "Home"]
    assert [x["page"] for x in items] == ["/simple/roadmap", "/simple"]
    assert all(x["last_at"] for x in items)
    for who in ROLES:
        assert all(x["page_name"] in ("Home", "Roadmap") for x in await recent(client, w, who))


async def test_chat_is_the_callers_own(client):
    w = await world()
    mine = await post(client, w, "commenter", "who owns Ledger v2?", page="/simple", new_chat=True)
    for who in ("owner", "approver", "viewer"):
        r = await client.get("/v1/simple/chat", params={"chat": mine["id"]}, headers=w.ctx.as_(who))
        assert r.status_code == 404, who
        r = await client.post(ASK, json={"text": "who owns Ledger v2?", "chat_id": mine["id"]},
                              headers=w.ctx.as_(who))  # fmt: skip
        assert r.status_code == 404, who
    m = await start(client, w)
    r = await client.post(f"{MEETINGS}/{m['id']}/chat/messages", json={"text": "who owns Ledger v2?"},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    meeting_chat = r.json()["id"]
    r = await client.get(
        "/v1/simple/chat", params={"chat": meeting_chat}, headers=w.ctx.as_("decider")
    )
    assert r.status_code == 404


async def test_link_ask_discussion(client):
    w = await world()
    chat = await post(client, w, "commenter", "who owns Ledger v2?", page="/simple", new_chat=True)

    async def discussion(who: str) -> str:
        r = await client.post("/v1/discussions", headers=w.ctx.as_(who), json={
            "subject_kind": "screen", "subject": {"path": "/simple", "label": "Home"},
            "origin": "panel", "visibility": "private"})  # fmt: skip
        assert r.status_code in (200, 201), r.text
        return r.json()["id"]

    theirs = await discussion("approver")
    r = await client.put(f"/v1/simple/chats/{chat['id']}/ask", json={"ask_id": theirs},
                         headers=w.ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 404
    ask = await discussion("commenter")
    r = await client.put(f"/v1/simple/chats/{chat['id']}/ask", json={"ask_id": ask},
                         headers=w.ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 404
    r = await client.put(f"/v1/simple/chats/{chat['id']}/ask", json={"ask_id": ask},
                         headers=w.ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["ask_id"] == ask
    assert (await recent(client, w, "commenter"))[0]["ask_id"] == ask
    r = await client.get(
        "/v1/simple/chat", params={"chat": chat["id"]}, headers=w.ctx.as_("commenter")
    )
    assert r.json()["ask_id"] == ask
