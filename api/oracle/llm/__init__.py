"""Oracle's own model calls on a connected Claude plan (see ``gateway``)."""

from oracle.llm.gateway import Completion, Transports, complete, set_transports
from oracle.llm.transports import LlmAuthError, LlmError, LlmUnavailable, NoClaudePlan

__all__ = [
    "Completion",
    "LlmAuthError",
    "LlmError",
    "LlmUnavailable",
    "NoClaudePlan",
    "Transports",
    "complete",
    "set_transports",
]
