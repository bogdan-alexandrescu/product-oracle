"""Oracle's own pydantic base model: every model the app defines builds its validator and
serializer at its first use, not at import. A route's request and response models are still
built when the app adds the route, the rest (LLM output shapes, internal records) by the
request that first needs them (oracle.startup: about 1 s of the app's 6 s import, before a
new instance could serve).

Only Oracle's models: pydantic's own BaseModel keeps building at class creation, so the
SDKs' and FastAPI's models are not deferred (two threadpool threads could race to build
one)."""

import pydantic


class BaseModel(pydantic.BaseModel):
    model_config = pydantic.ConfigDict(defer_build=True)
