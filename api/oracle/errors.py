"""Exception text for reasons people read."""


def exception_text(exc: BaseException) -> str:
    """The exception's message, or its type name when the message is blank.

    An httpx timeout's ``str()`` is empty, so ``f"cannot reach X: {exc}"`` would end in
    nothing; this gives ``"cannot reach X: ReadTimeout"`` instead.
    """
    return str(exc).strip() or type(exc).__name__
