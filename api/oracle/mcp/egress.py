"""Where a run token may come from: SwarmCloud's egress addresses only (Bogdan,
2026-10-18).

SwarmCloud sends a run's token to ``/mcp`` from the addresses ``GET /v1/mcp-servers`` lists
as ``egress_addresses`` (cached and refreshed by the runtime). People's OAuth sign-ins and
API tokens are not limited: there is no network allowlist on ``/mcp``.

Behind Oracle's load balancer the socket's peer is the load balancer, and the client's
address is in X-Forwarded-For. Anyone can send that header with any value, and each proxy
appends the address it saw, so only the entries Oracle's own proxies appended can be
trusted: the client is the entry ``ORACLE_TRUSTED_PROXY_HOPS`` places from the right
(Google's HTTPS load balancer appends ``<client>, <load balancer>``: one hop), never the
first.
"""

import ipaddress

from starlette.requests import Request

from oracle.swarm import get_runtime
from oracle.swarm.settings import get_runtime_settings


def client_address(request: Request, trusted_hops: int | None = None) -> str | None:
    """The calling client's address as Oracle's own proxies saw it; ``None`` when the
    request did not come through them as expected."""
    hops = get_runtime_settings().trusted_proxy_hops if trusted_hops is None else trusted_hops
    if hops <= 0:
        return request.client.host if request.client else None
    # Several X-Forwarded-For headers are one list, in order.
    entries = [
        part.strip()
        for value in request.headers.getlist("x-forwarded-for")
        for part in value.split(",")
        if part.strip()
    ]
    if len(entries) < hops + 1:
        return None
    return entries[-(hops + 1)]


def _same(a: str, b: str) -> bool:
    try:
        net = ipaddress.ip_network(b, strict=False)
        return ipaddress.ip_address(a) in net
    except ValueError:
        return a == b


async def run_token_allowed(request: Request) -> bool:
    """Whether a run token may be used from this request's client address."""
    allowed = await get_runtime().egress_addresses()
    if allowed is None:
        # A local runtime: its agents are Oracle's own.
        return True
    address = client_address(request)
    if address is None:
        return False
    return any(_same(address, a) for a in allowed)
