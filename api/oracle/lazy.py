"""A module imported at its first attribute read, for libraries a route uses but the app's
start does not need (oracle.startup: a new instance serves sooner)."""

import importlib
from typing import Any


class LazyModule:
    def __init__(self, name: str):
        self._name = name

    def __getattr__(self, attr: str) -> Any:
        return getattr(importlib.import_module(self._name), attr)
