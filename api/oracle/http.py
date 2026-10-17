from fastapi import HTTPException, status


def not_implemented(lane: str) -> HTTPException:
    """Placeholder for endpoints a later lane implements: ``raise not_implemented("1")``."""
    return HTTPException(status.HTTP_501_NOT_IMPLEMENTED, f"Not implemented yet (lane {lane})")
