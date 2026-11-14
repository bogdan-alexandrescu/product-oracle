from pydantic import BaseModel

# Every pydantic model builds its validator and serializer at its first use, not at import:
# a route's request and response models are still built when the app adds the route, the
# rest (LLM output shapes, internal records) by the request that first needs them.
# oracle.startup: about 1 s of the app's 6 s import, before a new instance could serve.
BaseModel.model_config["defer_build"] = True
