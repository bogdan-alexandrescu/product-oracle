"""A module imported at its first attribute read, for libraries a route uses but the app's
start does not need (oracle.startup: a new instance serves sooner)."""

import importlib
from types import ModuleType
from typing import Any


class LazyModule:
    def __init__(self, name: str):
        self._name = name
        self._module: ModuleType | None = None

    def __getattr__(self, attr: str) -> Any:
        # Only for names this object does not hold: imported once, then read off the module.
        if self._module is None:
            self._module = importlib.import_module(self._name)
        return getattr(self._module, attr)
