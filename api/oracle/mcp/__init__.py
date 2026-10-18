"""The ``/mcp`` Streamable HTTP server for agents (Lane D).

``server`` mounts the endpoint, ``auth`` verifies bearer tokens (a registry other
credentials plug into), ``tools`` turns every REST operation into a tool, ``curated``
adds the agent-facing wrappers and ``scopes`` maps run-token scopes onto operations.
"""
