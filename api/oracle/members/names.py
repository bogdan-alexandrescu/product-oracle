"""The one name rule for people in Oracle's pickers and labels (C2).

A member may have a name (A5: set by them, an owner, or their invite); without one,
``first.last@example.com`` reads "First Last". Every person picker a non-owner uses
(``GET /v1/people``) and every "<name> asks" label take their name from here.
"""

import re

_PARTS = re.compile(r"[._+-]+")


def display_name(email: str, name: str | None = None) -> str:
    """The member's own name when set (A5); else "first.last@example.com" -> "First
    Last"; the email itself when it has no name."""
    if name and name.strip():
        return name.strip()
    local = email.split("@", 1)[0]
    words = [w for w in _PARTS.split(local) if w]
    if not words:
        return email
    return " ".join(w[:1].upper() + w[1:] for w in words)
