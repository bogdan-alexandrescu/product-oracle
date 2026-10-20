"""Slack channel picker: the channels a user's Slack connection can read (S5).

Public channels and the private channels the person is in, through
``conversations.list`` with the user token. Direct messages (``im``, ``mpim``) are
never asked for and dropped if Slack returns one anyway (S3). A bot token (``xoxb-``)
is refused: it would list the private channels the bot is in, not the person's.
"""

import uuid
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from oracle.auth.deps import TenantDB
from oracle.connections import browse
from oracle.connections.browse import open_connection, provider_error, unreachable
from oracle.connections.router import ProviderHttp, UserPrincipal
from oracle.sources.base import ConnectorError
from oracle.sources.connectors.slack import _Slack, is_dm

router = APIRouter(prefix="/v1", tags=["connections"])

PAGE_SIZE = 200
# A search reads on through Slack's pages (it has no name filter) until it has this
# many matches or has read MAX_PAGES pages; the cursor resumes where it stopped.
SEARCH_RESULTS = 50
MAX_PAGES = 5
BOT_TOKEN = (
    "This Slack connection uses a bot token, which would list the bot's channels rather "
    "than yours: connect Slack with your own sign-in or a user token (xoxp-)"
)


class SlackChannelOut(BaseModel):
    id: str
    name: str
    is_private: bool
    is_archived: bool
    num_members: int | None
    topic: str | None


class SlackChannelPage(BaseModel):
    channels: list[SlackChannelOut]
    # Pass back as ``cursor`` for more; null at the end.
    next_cursor: str | None


def _channel(entry: dict[str, Any]) -> SlackChannelOut | None:
    if (
        entry.get("is_im")
        or entry.get("is_mpim")
        or is_dm(str(entry.get("id", "")), entry.get("name"))
    ):
        return None
    if not entry.get("id"):
        return None
    topic = ((entry.get("topic") or {}).get("value") or "").strip()
    return SlackChannelOut(
        id=entry["id"],
        name=entry.get("name") or entry["id"],
        is_private=bool(entry.get("is_private") or entry.get("is_group")),
        is_archived=bool(entry.get("is_archived")),
        num_members=entry.get("num_members"),
        topic=topic or None,
    )


@router.get(
    "/connections/{connection_id}/slack/channels",
    response_model=SlackChannelPage,
    responses={
        403: {"description": "Slack refused the request (the connection stays usable)"},
        404: {"description": "Not one of your Slack connections"},
        409: {"description": "The connection needs reconnecting, or holds a bot token"},
        429: {
            "description": "Slack is rate limiting, or this connection searched too often; "
            "retry after Retry-After seconds"
        },
    },
)
async def list_slack_channels(
    connection_id: uuid.UUID,
    principal: UserPrincipal,
    db: TenantDB,
    http: ProviderHttp,
    search: Annotated[str, Query(max_length=200)] = "",
    cursor: Annotated[str | None, Query(max_length=1000)] = None,
    include_archived: bool = False,
) -> SlackChannelPage:
    """Public channels and the private channels you are in, by name; never DMs.

    Answers are cached for a minute per connection, and a connection may search Slack
    a limited number of times a minute."""
    conn, token = await open_connection(db, principal, connection_id, "slack")
    if token.startswith("xoxb-"):
        raise HTTPException(status.HTTP_409_CONFLICT, BOT_TOKEN)
    key = ("slack/channels", search, cursor, include_archived)
    hit = browse.cached(conn, key)
    if hit is not None:
        return hit
    browse.admit(conn, "Slack")
    slack = _Slack(http, token)
    needle = search.strip().lstrip("#").lower()
    want = SEARCH_RESULTS if needle else 1
    found: list[SlackChannelOut] = []
    next_cursor = cursor or None
    try:
        for _ in range(MAX_PAGES):
            page = await slack.call(
                "conversations.list",
                types="public_channel,private_channel",
                exclude_archived="false" if include_archived else "true",
                limit=PAGE_SIZE,
                **({"cursor": next_cursor} if next_cursor else {}),
            )
            for entry in page.get("channels") or []:
                out = _channel(entry)
                if out is None or (out.is_archived and not include_archived):
                    continue
                if needle and needle not in out.name.lower():
                    continue
                found.append(out)
            next_cursor = (page.get("response_metadata") or {}).get("next_cursor") or None
            if next_cursor is None or len(found) >= want:
                break
    except ConnectorError as e:
        raise await provider_error(db, conn, "Slack", e) from None
    except (httpx.HTTPError, ValueError):
        raise unreachable("Slack") from None
    answer = SlackChannelPage(channels=found, next_cursor=next_cursor)
    browse.remember(conn, key, answer)
    return answer
