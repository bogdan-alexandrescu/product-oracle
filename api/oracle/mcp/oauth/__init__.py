"""OAuth 2.1 authorization server for MCP clients (Lane D2).

External MCP clients register themselves (RFC 7591), send the user through
``/oauth/authorize`` and the consent screen, and exchange the code with PKCE for an
opaque access token that ``/mcp`` accepts (see :mod:`oracle.mcp.oauth.verify`).
"""
