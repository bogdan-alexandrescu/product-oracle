import json
from typing import Any

from fastapi import HTTPException, Request, status

# The largest request body a route reading it raw (a YAML graph, a markdown draft) takes.
MAX_BODY_BYTES = 20 * 1024 * 1024


def not_implemented(lane: str) -> HTTPException:
    """Placeholder for endpoints a later lane implements: ``raise not_implemented("1")``."""
    return HTTPException(status.HTTP_501_NOT_IMPLEMENTED, f"Not implemented yet (lane {lane})")


async def read_body(request: Request) -> bytes:
    """The request's body, refused (413) past :data:`MAX_BODY_BYTES` as it is read, not
    after. A route calls it before it takes the review gate: a slow client never holds
    the gate while its body arrives."""
    too_large = HTTPException(
        413,
        f"body larger than {MAX_BODY_BYTES // (1024 * 1024) or 1} MB",
    )
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        raise too_large
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            raise too_large
    return bytes(body)


# A multipart upload's whole request: several files of uploads.MAX_BYTES each, streamed to
# disk by the form parser as they arrive (each file is capped again when it is read).
MAX_UPLOAD_REQUEST_BYTES = 100 * 1024 * 1024


def _limit_for(content_type: bytes) -> int:
    media = content_type.split(b";", 1)[0].strip().lower()
    return MAX_UPLOAD_REQUEST_BYTES if media == b"multipart/form-data" else MAX_BODY_BYTES


def _too_large(limit: int) -> str:
    return f"request body larger than {limit // (1024 * 1024) or 1} MB"


class BodyLimit:
    """Every request's body is capped while it arrives, whatever the route does with it
    (JSON, a raw draft, a form): :data:`MAX_BODY_BYTES`, or for a multipart upload
    :data:`MAX_UPLOAD_REQUEST_BYTES`. A Content-Length over the cap is refused (413) before
    anything is read; a body that grows past it (chunked, or longer than it said) is
    refused as soon as it does, and nothing more of it is read."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or [])
        limit = _limit_for(headers.get(b"content-type", b""))
        length = headers.get(b"content-length", b"")
        if length.isdigit() and int(length) > limit:
            body = json.dumps({"detail": _too_large(limit)}).encode()
            await send(
                {
                    "type": "http.response.start",
                    "status": 413,
                    "headers": [
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                        (b"connection", b"close"),
                    ],
                }
            )
            await send({"type": "http.response.body", "body": body})
            return
        received = 0

        async def limited() -> dict[str, Any]:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, _too_large(limit))
            return message

        await self.app(scope, limited, send)
