"""The Claude account pool behind Oracle's built-in model jobs.

A port of SwarmCloud's account management (quota-broker, agent-worker, swarm-api,
swarm-ui, swarm-mcp); see ``docs/claude-accounts.md``. ``accounts`` is the pure logic,
``store`` every transaction, ``credentials`` the single writer, ``sweep`` the scheduled
refresh and usage poll, ``pool`` assignment for one call, ``router`` the API.
"""
