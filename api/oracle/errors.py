"""Exception text for reasons people read."""


def exception_text(exc: BaseException) -> str:
    """The exception's message, or its type name when the message is blank.

    An httpx timeout's ``str()`` is empty, so ``f"cannot reach X: {exc}"`` would end in
    nothing; this gives ``"cannot reach X: ReadTimeout"`` instead.
    """
    return str(exc).strip() or type(exc).__name__


#: A read that may degrade says which of three states it is in, never a bare None or 0
#: that looks like an answer (#1574).
FETCHED = "fetched"
UNAVAILABLE = "unavailable"
NOT_APPLICABLE = "not_applicable"


def read_state(exc: BaseException | None = None, *, applies: bool = True) -> dict[str, str]:
    """``{"state": "fetched"}``; ``{"state": "unavailable", "reason": ...}`` when the read
    raised ``exc``; ``{"state": "not_applicable"}`` when there was nothing to read."""
    if not applies:
        return {"state": NOT_APPLICABLE}
    if exc is not None:
        return {"state": UNAVAILABLE, "reason": exception_text(exc)[:200]}
    return {"state": FETCHED}
