"""Oracle's built-in model calls on the Claude account pool (see ``gateway``)."""

from oracle.llm.gateway import Completion, Transports, complete, set_transports
from oracle.llm.transports import (
    LlmAuthError,
    LlmError,
    LlmRateLimited,
    LlmUnavailable,
    NoClaudeAccount,
)

__all__ = [
    "Completion",
    "LlmAuthError",
    "LlmError",
    "LlmRateLimited",
    "LlmUnavailable",
    "NoClaudeAccount",
    "Transports",
    "complete",
    "set_transports",
]
