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
