"""Oracle's routers: a route's request handling is built at its first use, not at import.

FastAPI (0.143) builds each route twice: once when the route is declared (its dependency
tree, its request and response fields, its handler), and again, per inclusion, the first
time a request reaches the router that includes it. For a route served through
``app.include_router`` (all of Oracle's but /healthz) the first build is only read for the
route's declared settings (path, methods, response model, ...): so the declared settings
are set at once, the rest the first time something reads them (a request to a route
declared on the app itself, the OpenAPI document). oracle.startup: about
40% of the app's import on one CPU, before a new instance could serve.
"""

import inspect
import threading
from enum import IntEnum
from typing import Any

import fastapi
from fastapi import routing as fastapi_routing
from fastapi.datastructures import Default, DefaultPlaceholder
from fastapi.dependencies.utils import get_typed_return_annotation
from fastapi.routing import APIRoute
from fastapi.utils import generate_unique_id
from starlette.responses import Response
from starlette.routing import compile_path, get_name

# One build at a time: a route read from two threadpool threads is built once.
_building = threading.RLock()


def _declared_state(
    route: Any,
    path: str,
    endpoint: Any,
    *,
    response_model: Any = Default(None),
    status_code: int | None = None,
    tags: list | None = None,
    dependencies: Any = None,
    summary: str | None = None,
    description: str | None = None,
    response_description: str = "Successful Response",
    responses: dict | None = None,
    deprecated: bool | None = None,
    name: str | None = None,
    methods: Any = None,
    operation_id: str | None = None,
    response_model_include: Any = None,
    response_model_exclude: Any = None,
    response_model_by_alias: bool = True,
    response_model_exclude_unset: bool = False,
    response_model_exclude_defaults: bool = False,
    response_model_exclude_none: bool = False,
    include_in_schema: bool = True,
    response_class: Any = Default(fastapi_routing.JSONResponse),
    dependency_overrides_provider: Any = None,
    callbacks: Any = None,
    openapi_extra: Any = None,
    generate_unique_id_function: Any = Default(generate_unique_id),
    strict_content_type: Any = Default(True),
    stream_item_type: Any = None,
) -> None:
    """The settings fastapi.routing._populate_api_route_state sets from the declaration,
    the same way, without the dependency tree or the fields (tests/test_startup.py checks
    every route of the app against FastAPI's own build)."""
    route.path = path
    route.endpoint = endpoint
    route.stream_item_type = stream_item_type
    route.summary = summary
    route.response_description = response_description
    route.deprecated = deprecated
    route.operation_id = operation_id
    route.response_model_include = response_model_include
    route.response_model_exclude = response_model_exclude
    route.response_model_by_alias = response_model_by_alias
    route.response_model_exclude_unset = response_model_exclude_unset
    route.response_model_exclude_defaults = response_model_exclude_defaults
    route.response_model_exclude_none = response_model_exclude_none
    route.include_in_schema = include_in_schema
    route.response_class = response_class
    route.dependency_overrides_provider = dependency_overrides_provider
    route.callbacks = callbacks
    route.openapi_extra = openapi_extra
    route.generate_unique_id_function = generate_unique_id_function
    route.strict_content_type = strict_content_type
    route.tags = tags or []
    route.responses = responses or {}
    route.name = get_name(endpoint) if name is None else name
    route.path_regex, route.path_format, route.param_convertors = compile_path(path)
    route.methods = {method.upper() for method in (methods or ["GET"])}
    if isinstance(generate_unique_id_function, DefaultPlaceholder):
        generate_unique_id_function = generate_unique_id_function.value
    route.unique_id = route.operation_id or generate_unique_id_function(route)
    route.status_code = int(status_code) if isinstance(status_code, IntEnum) else status_code
    route.dependencies = list(dependencies or [])
    route.description = (
        (description or inspect.cleandoc(endpoint.__doc__ or "")).split("\f")[0].strip()
    )
    if isinstance(response_model, DefaultPlaceholder):
        is_generator = fastapi_routing._is_async_gen_callable(
            endpoint
        ) or fastapi_routing._is_gen_callable(endpoint)
        return_annotation = get_typed_return_annotation(endpoint)
        if fastapi_routing.lenient_issubclass(return_annotation, Response):
            response_model = None
        else:
            stream_item = fastapi_routing.get_stream_item_type(return_annotation)
            if stream_item is not None and is_generator:
                if (
                    isinstance(response_class, DefaultPlaceholder)
                    or fastapi_routing.lenient_issubclass(
                        response_class, fastapi_routing.EventSourceResponse
                    )
                ) and not fastapi_routing.lenient_issubclass(
                    stream_item, fastapi_routing.ServerSentEvent
                ):
                    route.stream_item_type = stream_item
                response_model = None
            else:
                response_model = return_annotation
    route.response_model = response_model


class LazyAPIRoute(APIRoute):
    """An APIRoute whose dependency tree, fields and handler are built at the first read of
    any of them (FastAPI's own build, unchanged)."""

    def __init__(self, path: str, endpoint: Any, **kwargs: Any) -> None:
        self._declared = (path, endpoint, kwargs)
        _declared_state(self, path, endpoint, **kwargs)

    def __getattr__(self, attr: str) -> Any:
        # Only for what is not set yet: the parts FastAPI's build makes.
        if attr.startswith("__"):
            raise AttributeError(attr)
        with _building:
            declared = self.__dict__.get("_declared")
            # The build's own reads of what it has not set yet (it runs under the lock).
            if declared is not None and self.__dict__.get("_in_build"):
                raise AttributeError(attr)
            if declared is not None:
                # Another thread's read waits on the lock, then finds the route built; a
                # build that raises leaves the route as declared, to be tried again.
                self._in_build = True
                try:
                    path, endpoint, kwargs = declared
                    APIRoute.__init__(self, path, endpoint, **kwargs)
                finally:
                    del self._in_build
                del self._declared
        return object.__getattribute__(self, attr)


class APIRouter(fastapi.APIRouter):
    """fastapi.APIRouter whose routes are LazyAPIRoute unless another class is given."""

    def __init__(self, *args: Any, route_class: type[APIRoute] = LazyAPIRoute, **kwargs: Any):
        super().__init__(*args, route_class=route_class, **kwargs)
