from fastapi import HTTPException, Request, status

from oracle.config import get_settings


def not_implemented(lane: str) -> HTTPException:
    """Placeholder for endpoints a later lane implements: ``raise not_implemented("1")``."""
    return HTTPException(status.HTTP_501_NOT_IMPLEMENTED, f"Not implemented yet (lane {lane})")


async def read_capped_body(request: Request, limit: int | None = None) -> bytes:
    """The request body, read in chunks and refused (413) past ``limit`` bytes
    (``ORACLE_MAX_BODY_BYTES``, 1 MiB): an untrusted body is never buffered whole."""
    cap = get_settings().max_body_bytes if limit is None else limit
    too_large = HTTPException(
        status.HTTP_413_CONTENT_TOO_LARGE, f"request body is larger than {cap} bytes"
    )
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > cap:
        raise too_large
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > cap:
            raise too_large
        chunks.append(chunk)
    return b"".join(chunks)
