"""Source connectors (Lanes B2a, B2b). Importing this package registers every connector.

Each module registers its connector with :func:`oracle.sources.base.register` at import
time; add a module by adding it to the import list below.
"""

from oracle.sources.connectors import (  # noqa: F401
    fireflies,
    github,
    google_docs,
    notion,
    slack,
)
