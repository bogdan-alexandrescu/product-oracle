from fastapi import HTTPException, Request, status


def not_implemented(lane: str) -> HTTPException:
    """Placeholder for endpoints a later lane implements: ``raise not_implemented("1")``."""
    return HTTPException(status.HTTP_501_NOT_IMPLEMENTED, f"Not implemented yet (lane {lane})")


async def read_capped(request: Request, limit: int) -> bytes:
    """The request body, at most ``limit`` bytes: a larger body is refused with 413 as soon
    as its Content-Length (or the bytes received so far) pass the limit, before the rest is
    read."""
    too_large = HTTPException(
        status.HTTP_413_CONTENT_TOO_LARGE, f"request body over {limit} bytes"
    )
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise too_large
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > limit:
            raise too_large
        chunks.append(chunk)
    return b"".join(chunks)
